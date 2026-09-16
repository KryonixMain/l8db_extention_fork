use l8db_extension::{json, Api, Context, Error, Extension, Result, StatusBarUpdate, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[derive(Default)]
struct HelloExtension {
    listening: Option<String>,
}

impl HelloExtension {
    async fn start_listener(&mut self, api: &Api) -> Result<Value> {
        if let Some(address) = &self.listening {
            return Ok(json!({ "address": address, "reused": true }));
        }
        let listener = TcpListener::bind("0.0.0.0:0").await.map_err(|e| Error(e.to_string()))?;
        let address = listener.local_addr().map_err(|e| Error(e.to_string()))?.to_string();
        self.listening = Some(address.clone());
        let announced = api.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, peer)) = listener.accept().await else {
                    break;
                };
                announced.info(format!("client connected from {peer}")).await;
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stream);
                    let mut line = String::new();
                    while let Ok(read) = reader.read_line(&mut line).await {
                        if read == 0 {
                            break;
                        }
                        let echo = format!("echo {line}");
                        if reader.get_mut().write_all(echo.as_bytes()).await.is_err() {
                            break;
                        }
                        line.clear();
                    }
                });
            }
        });
        api.set_status_bar(
            "hello.listener",
            StatusBarUpdate {
                text: format!("Listening on {address}"),
                ..Default::default()
            },
        )
        .await?;
        Ok(json!({ "address": address, "reused": false }))
    }
}

#[l8db_extension::async_trait]
impl Extension for HelloExtension {
    async fn activate(&mut self, context: &Context, api: &Api) -> Result<()> {
        api.info(format!("hello-rust-extension activated as {}", context.extension_id)).await;
        api.register_command("hello.greet").await?;
        api.register_command("hello.listen").await?;
        Ok(())
    }

    async fn deactivate(&mut self, api: &Api) -> Result<()> {
        self.listening = None;
        api.hide_status_bar("hello.listener").await
    }

    async fn execute(&mut self, command: &str, payload: Value, api: &Api) -> Result<Value> {
        match command {
            "hello.greet" => {
                let who = payload.get("name").and_then(Value::as_str).unwrap_or("world");
                api.show_info(&format!("Hello, {who}!")).await?;
                Ok(json!({ "greeted": who }))
            }
            "hello.listen" => self.start_listener(api).await,
            other => Err(Error(format!("CommandNotFoundError: {other}"))),
        }
    }
}

fn main() -> Result<()> {
    l8db_extension::run(HelloExtension::default())
}
