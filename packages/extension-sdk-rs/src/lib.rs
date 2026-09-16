mod api;
mod protocol;

pub use api::{
    Api, DatabaseInfo, DirectoryEntry, DirectoryListing, EditorChange, EditorContentChange, EditorDocument, EditorDocumentInfo,
    EditorSelection, MediaFrame, MediaRequest, MediaTrackInfo, PeerCursor, QueryResult,
    StatusBarUpdate, TreeItem, WorkspaceChange,
};
pub use async_trait::async_trait;
pub use protocol::Context;
pub use serde_json::{json, Value};

use api::Client;
use protocol::{Incoming, Outgoing, MAX_LINE};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<String> for Error {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for Error {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self(value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);

#[async_trait::async_trait]
pub trait Extension: Send + 'static {
    async fn activate(&mut self, context: &Context, api: &Api) -> Result<()>;
    async fn deactivate(&mut self, _api: &Api) -> Result<()> {
        Ok(())
    }
    async fn execute(&mut self, command: &str, _payload: Value, _api: &Api) -> Result<Value> {
        Err(Error(format!("CommandNotFoundError: {command}")))
    }
    async fn event(&mut self, _name: &str, _payload: Value, _binary: Vec<u8>, _api: &Api) {}
}

pub fn run<E: Extension>(extension: E) -> Result<()> {
    let runtime = tokio::runtime::Runtime::new().map_err(|e| Error(e.to_string()))?;
    runtime.block_on(serve(extension))
}

async fn serve<E: Extension>(extension: E) -> Result<()> {
    let (outbox, mut inbox) = mpsc::channel::<String>(256);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = inbox.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.write_all(b"\n").await.is_err() || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });
    let client = Arc::new(Client::new(outbox));
    let api = Api(client.clone());
    let extension = Arc::new(Mutex::new(extension));
    let context: Arc<Mutex<Option<Context>>> = Arc::new(Mutex::new(None));
    let mut reader = BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).await.map_err(|e| Error(e.to_string()))?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_LINE {
            let _ = api.0.send(Outgoing::Crash {error: "Host message exceeds the line limit".into()}).await;
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let incoming: Incoming = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(error) => {
                let _ = api.0.send(Outgoing::Crash {error: format!("Malformed host message: {error}")}).await;
                continue;
            }
        };
        match incoming {
            Incoming::Terminate => break,
            Incoming::RpcResult(result) => {
                let settled = match result.error {
                    Some(error) => Err(Error(error)),
                    None => Ok(result.value),
                };
                client.settle(result.id, settled);
            }
            Incoming::Event(event) => {
                let mut binary = Vec::new();
                if let Some(length) = event.bytes {
                    if length > MAX_LINE {
                        let _ = api.0.send(Outgoing::Crash {error: "Host attachment exceeds the limit".into()}).await;
                        break;
                    }
                    binary.resize(length, 0);
                    if reader.read_exact(&mut binary).await.is_err() {
                        break;
                    }
                }
                let extension = extension.clone();
                let api = api.clone();
                tokio::spawn(async move {
                    extension.lock().await.event(&event.name, event.payload, binary, &api).await;
                });
            }
            Incoming::Request(request) => {
                let extension = extension.clone();
                let api = api.clone();
                let context = context.clone();
                tokio::spawn(async move {
                    let id = request.id;
                    let outcome = dispatch(&extension, &context, &api, request).await;
                    let message = match outcome {
                        Ok(value) => Outgoing::Result {
                            id,
                            value: Some(value),
                            error: None,
                        },
                        Err(error) => Outgoing::Result {
                            id,
                            value: None,
                            error: Some(error.0),
                        },
                    };
                    let _ = api.0.send(message).await;
                });
            }
        }
    }
    client.fail_all("The l8db host closed the connection");
    drop(api);
    drop(client);
    let _ = tokio::time::timeout(SHUTDOWN_GRACE, writer).await;
    Ok(())
}

async fn dispatch<E: Extension>(
    extension: &Arc<Mutex<E>>,
    context: &Arc<Mutex<Option<Context>>>,
    api: &Api,
    request: protocol::Request,
) -> Result<Value> {
    match request.method.as_str() {
        "load" => {
            let loaded = request.context.ok_or_else(|| Error("Missing extension context".into()))?;
            *context.lock().await = Some(loaded);
            Ok(Value::Null)
        }
        "activate" => {
            let current = context.lock().await.clone().ok_or_else(|| Error("Activated before load".into()))?;
            extension.lock().await.activate(&current, api).await?;
            Ok(Value::Null)
        }
        "deactivate" => {
            extension.lock().await.deactivate(api).await?;
            Ok(Value::Null)
        }
        "execute" => {
            let command = request.command.ok_or_else(|| Error("Missing command".into()))?;
            extension.lock().await.execute(&command, request.payload.unwrap_or(Value::Null), api).await
        }
        other => Err(Error(format!("Unknown runtime request: {other}"))),
    }
}
