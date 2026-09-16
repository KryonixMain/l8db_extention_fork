use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_LINE: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Incoming {
    Request(Request),
    Event(Event),
    RpcResult(RpcResult),
    Terminate,
}

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub context: Option<Context>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct Event {
    pub name: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
pub struct RpcResult {
    pub id: u64,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub extension_id: String,
    pub extension_path: String,
    pub storage_path: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Outgoing {
    Result {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Rpc {
        id: u64,
        method: String,
        args: Vec<Value>,
    },
    Crash {
        error: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_requests() {
        let line = r#"{"type":"request","id":1,"method":"execute","command":"demo.hello","payload":null}"#;
        let Incoming::Request(request) = serde_json::from_str(line).unwrap() else {
            panic!("expected a request");
        };
        assert_eq!(request.id, 1);
        assert_eq!(request.method, "execute");
        assert_eq!(request.command.as_deref(), Some("demo.hello"));
    }

    #[test]
    fn parses_load_with_context() {
        let line = r#"{"type":"request","id":1,"method":"load","context":{"extensionId":"acme.demo","extensionPath":"extension://acme.demo/","storagePath":"extension-storage://acme.demo/"}}"#;
        let Incoming::Request(request) = serde_json::from_str(line).unwrap() else {
            panic!("expected a request");
        };
        assert_eq!(request.context.unwrap().extension_id, "acme.demo");
    }

    #[test]
    fn parses_rpc_results_and_events() {
        let line = r#"{"type":"rpc-result","id":7,"value":{"ok":true}}"#;
        let Incoming::RpcResult(result) = serde_json::from_str(line).unwrap() else {
            panic!("expected an rpc result");
        };
        assert_eq!(result.id, 7);
        assert!(result.error.is_none());
        let line = r#"{"type":"event","name":"databaseOpened","payload":{"name":"db"}}"#;
        let Incoming::Event(event) = serde_json::from_str(line).unwrap() else {
            panic!("expected an event");
        };
        assert_eq!(event.name, "databaseOpened");
    }

    #[test]
    fn serialises_outgoing_messages_as_the_host_expects() {
        let rpc = Outgoing::Rpc {
            id: 3,
            method: "database.query".into(),
            args: vec![Value::String("select 1".into())],
        };
        assert_eq!(
            serde_json::to_string(&rpc).unwrap(),
            r#"{"type":"rpc","id":3,"method":"database.query","args":["select 1"]}"#
        );
        let ok = Outgoing::Result {
            id: 4,
            value: Some(Value::Null),
            error: None,
        };
        assert_eq!(
            serde_json::to_string(&ok).unwrap(),
            r#"{"type":"result","id":4,"value":null}"#
        );
        let failed = Outgoing::Result {
            id: 5,
            value: None,
            error: Some("boom".into()),
        };
        assert_eq!(
            serde_json::to_string(&failed).unwrap(),
            r#"{"type":"result","id":5,"error":"boom"}"#
        );
    }

    #[test]
    fn outgoing_messages_never_contain_newlines() {
        let rpc = Outgoing::Rpc {
            id: 1,
            method: "logger".into(),
            args: vec![Value::String("line\nbreak".into())],
        };
        assert!(!serde_json::to_string(&rpc).unwrap().contains('\n'));
    }
}
