use crate::protocol::Outgoing;
use crate::{Error, Result};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub connection_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<HashMap<String, Option<String>>>,
    pub rows_affected: Option<i64>,
    pub execution_time_ms: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeItem {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collapsible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expanded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeItem>>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusBarUpdate {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocumentInfo {
    pub document_id: String,
    pub title: String,
    pub language_id: String,
    pub version: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocument {
    pub document_id: String,
    pub title: String,
    pub language_id: String,
    pub version: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorChange {
    pub start: u64,
    pub end: u64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorContentChange {
    pub document_id: String,
    pub changes: Vec<EditorChange>,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSelection {
    pub document_id: String,
    pub anchor: u64,
    pub active: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerCursor {
    pub peer_id: String,
    pub label: String,
    pub color: String,
    pub anchor: u64,
    pub active: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTrackInfo {
    pub track_id: String,
    pub source: String,
    pub video: bool,
    pub audio: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub muted: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFrame {
    pub track_id: String,
    pub kind: String,
    pub keyframe: bool,
    pub timestamp: i64,
    pub duration: Option<i64>,
    #[serde(skip)]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub hidden: bool,
    pub size: Option<u64>,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<DirectoryEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChange {
    pub root: String,
    pub paths: Vec<String>,
}

pub(crate) struct Client {
    sequence: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>,
    outbox: mpsc::Sender<String>,
}

impl Client {
    pub(crate) fn new(outbox: mpsc::Sender<String>) -> Self {
        Self {
            sequence: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
            outbox,
        }
    }
    pub(crate) fn settle(&self, id: u64, value: Result<Value>) {
        let sender = self.pending.lock().ok().and_then(|mut pending| pending.remove(&id));
        if let Some(sender) = sender {
            let _ = sender.send(value);
        }
    }
    pub(crate) fn fail_all(&self, reason: &str) {
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(Error(reason.to_string())));
        }
    }
    pub(crate) async fn send(&self, message: Outgoing) -> Result<()> {
        let line = serde_json::to_string(&message).map_err(|e| Error(e.to_string()))?;
        self.outbox.send(line).await.map_err(|_| Error("The l8db host closed the connection".into()))
    }
    async fn call(&self, method: &str, args: Vec<Value>) -> Result<Value> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().map_err(|_| Error("Extension client poisoned".into()))?.insert(id, sender);
        if let Err(error) = self
            .send(Outgoing::Rpc {
                id,
                method: method.to_string(),
                args,
            }).await
        {
            self.pending.lock().ok().and_then(|mut p| p.remove(&id));
            return Err(error);
        }
        receiver
            .await
            .map_err(|_| Error("The l8db host dropped the request".into()))?
    }
}

#[derive(Clone)]
pub struct Api(pub(crate) Arc<Client>);

impl Api {
    pub async fn call(&self, method: &str, args: Vec<Value>) -> Result<Value> {
        self.0.call(method, args).await
    }
    async fn typed<T: DeserializeOwned>(&self, method: &str, args: Vec<Value>) -> Result<T> {
        let value = self.0.call(method, args).await?;
        serde_json::from_value(value).map_err(|e| Error(e.to_string()))
    }
    async fn unit(&self, method: &str, args: Vec<Value>) -> Result<()> {
        self.0.call(method, args).await.map(|_| ())
    }

    pub async fn log(&self, level: &str, message: impl AsRef<str>) {
        let _ = self.unit("logger", vec![json!(level), json!(message.as_ref())]).await;
    }
    pub async fn info(&self, message: impl AsRef<str>) {
        self.log("info", message).await;
    }
    pub async fn warn(&self, message: impl AsRef<str>) {
        self.log("warn", message).await;
    }
    pub async fn error(&self, message: impl AsRef<str>) {
        self.log("error", message).await;
    }

    pub async fn register_command(&self, id: &str) -> Result<()> {
        self.unit("commands.register", vec![json!(id)]).await
    }
    pub async fn execute_command(&self, id: &str, payload: Value) -> Result<Value> {
        self.call("commands.execute", vec![json!(id), payload]).await
    }
    pub async fn list_commands(&self) -> Result<Vec<String>> {
        self.typed("commands.list", vec![]).await
    }

    pub async fn subscribe(&self, event: &str) -> Result<()> {
        self.unit("events.on", vec![json!(event)]).await
    }

    pub async fn active_database(&self) -> Result<Option<DatabaseInfo>> {
        self.typed("database.active", vec![]).await
    }
    pub async fn query(&self, sql: &str) -> Result<QueryResult> {
        self.typed("database.query", vec![json!(sql), Value::Null]).await
    }
    pub async fn query_with_params(&self, sql: &str, params: Vec<Value>) -> Result<QueryResult> {
        self.typed("database.query", vec![json!(sql), json!(params)]).await
    }

    pub async fn show_info(&self, message: &str) -> Result<()> {
        self.unit("notifications.show", vec![json!("info"), json!(message), json!([])]).await
    }
    pub async fn show_warning(&self, message: &str) -> Result<()> {
        self.unit("notifications.show", vec![json!("warn"), json!(message), json!([])]).await
    }
    pub async fn show_error(&self, message: &str) -> Result<()> {
        self.unit("notifications.show", vec![json!("error"), json!(message), json!([])]).await
    }
    pub async fn ask(&self, message: &str, actions: Vec<&str>) -> Result<Option<String>> {
        self.typed("window.showMessage", vec![json!("info"), json!(message), json!(actions)]).await
    }
    pub async fn show_input_box(&self, options: Value) -> Result<Option<String>> {
        self.typed("window.showInputBox", vec![options]).await
    }
    pub async fn show_quick_pick(&self, items: Vec<Value>, options: Value) -> Result<Value> {
        self.call("window.showQuickPick", vec![json!(items), options]).await
    }

    pub async fn configuration<T: DeserializeOwned>(&self, key: &str) -> Result<T> {
        self.typed("configuration.get", vec![json!(key)]).await
    }
    pub async fn watch_configuration(&self) -> Result<()> {
        self.unit("configuration.onDidChange", vec![]).await
    }

    pub async fn storage_get<T: DeserializeOwned>(&self, key: &str) -> Result<T> {
        self.typed("storage.get", vec![json!(key)]).await
    }
    pub async fn storage_set(&self, key: &str, value: Value) -> Result<()> {
        self.unit("storage.set", vec![json!(key), value]).await
    }
    pub async fn secret_get(&self, key: &str) -> Result<Option<String>> {
        self.typed("secrets.get", vec![json!(key)]).await
    }
    pub async fn secret_set(&self, key: &str, value: &str) -> Result<()> {
        self.unit("secrets.set", vec![json!(key), json!(value)]).await
    }
    pub async fn secret_delete(&self, key: &str) -> Result<()> {
        self.unit("secrets.delete", vec![json!(key)]).await
    }

    pub async fn set_tree(&self, view_id: &str, items: Vec<TreeItem>) -> Result<()> {
        self.unit("views.setTree", vec![json!(view_id), json!(items)])
            .await
    }
    pub async fn reveal_view(&self, view_id: &str) -> Result<()> {
        self.unit("views.reveal", vec![json!(view_id)]).await
    }
    pub async fn set_status_bar(&self, item_id: &str, update: StatusBarUpdate) -> Result<()> {
        self.unit("statusBar.set", vec![json!(item_id), json!(update)])
            .await
    }
    pub async fn hide_status_bar(&self, item_id: &str) -> Result<()> {
        self.unit("statusBar.hide", vec![json!(item_id)]).await
    }

    pub async fn open_panel(&self, panel_id: &str, html: &str) -> Result<()> {
        self.unit("panels.open", vec![json!(panel_id), json!(html)])
            .await
    }
    pub async fn close_panel(&self, panel_id: &str) -> Result<()> {
        self.unit("panels.close", vec![json!(panel_id)]).await
    }
    pub async fn post_to_panel(&self, panel_id: &str, message: Value) -> Result<()> {
        self.unit("panels.postMessage", vec![json!(panel_id), message])
            .await
    }
    pub async fn watch_panel(&self, panel_id: &str) -> Result<()> {
        self.unit("panels.onMessage", vec![json!(panel_id)]).await
    }

    pub async fn active_document(&self) -> Result<Option<EditorDocument>> {
        self.typed("editor.getActive", vec![]).await
    }
    pub async fn list_documents(&self) -> Result<Vec<EditorDocumentInfo>> {
        self.typed("editor.listDocuments", vec![]).await
    }
    pub async fn document(&self, document_id: &str) -> Result<EditorDocument> {
        self.typed("editor.getDocument", vec![json!(document_id)])
            .await
    }
    pub async fn apply_edits(
        &self,
        document_id: &str,
        edits: Vec<EditorChange>,
        base_version: Option<u64>,
    ) -> Result<u64> {
        self.typed(
            "editor.applyEdits",
            vec![json!(document_id), json!(edits), json!(base_version)],
        ).await
    }
    pub async fn selection(&self, document_id: &str) -> Result<Option<EditorSelection>> {
        self.typed("editor.getSelection", vec![json!(document_id)]).await
    }
    pub async fn set_selection(&self, document_id: &str, anchor: u64, active: u64) -> Result<()> {
        self.unit("editor.setSelection", vec![json!(document_id), json!(anchor), json!(active)]).await
    }
    pub async fn reveal(&self, document_id: &str, offset: u64) -> Result<()> {
        self.unit("editor.reveal", vec![json!(document_id), json!(offset)]).await
    }
    pub async fn set_peer_cursors(&self, document_id: &str, cursors: Vec<PeerCursor>) -> Result<()> {
        self.unit("editor.setPeerCursors", vec![json!(document_id), json!(cursors)]).await
    }

    pub async fn start_capture(&self, request: MediaRequest) -> Result<MediaTrackInfo> {
        self.typed("media.start", vec![json!(request)]).await
    }
    pub async fn start_screen_share(&self, request: MediaRequest) -> Result<MediaTrackInfo> {
        self.typed("media.startScreenShare", vec![json!(request)]).await
    }
    pub async fn stop_capture(&self, track_id: &str) -> Result<()> {
        self.unit("media.stop", vec![json!(track_id)]).await
    }
    pub async fn list_capture(&self) -> Result<Vec<MediaTrackInfo>> {
        self.typed("media.list", vec![]).await
    }
    pub async fn set_capture_muted(&self, track_id: &str, muted: bool) -> Result<()> {
        self.unit("media.setMuted", vec![json!(track_id), json!(muted)]).await
    }

    pub async fn open_directory_dialog(&self, title: Option<&str>) -> Result<Option<String>> {
        self.typed("workspace.showOpenDirectoryDialog", vec![json!(title)]).await
    }
    pub async fn list_directory(&self, path: &str, include_hidden: bool) -> Result<DirectoryListing> {
        self.typed("workspace.listDirectory", vec![json!(path), json!({ "includeHidden": include_hidden })]).await
    }
    pub async fn granted_roots(&self) -> Result<Vec<String>> {
        self.typed("workspace.grantedRoots", vec![]).await
    }
    pub async fn watch_directory(&self, path: &str) -> Result<()> {
        self.unit("workspace.watch", vec![json!(path)]).await
    }
    pub async fn unwatch_directory(&self, path: &str) -> Result<()> {
        self.unit("workspace.unwatch", vec![json!(path)]).await
    }
    pub async fn read_text_file(&self, path: &str) -> Result<String> {
        self.typed("workspace.readFile", vec![json!(path)]).await
    }
    pub async fn write_text_file(&self, path: &str, contents: &str) -> Result<()> {
        self.unit("workspace.writeFile", vec![json!(path), json!(contents)]).await
    }

    pub async fn read_asset(&self, path: &str) -> Result<String> {
        self.typed("assets.readText", vec![json!(path)]).await
    }
    pub async fn clipboard_read(&self) -> Result<String> {
        self.typed("clipboard.read", vec![]).await
    }
    pub async fn clipboard_write(&self, value: &str) -> Result<()> {
        self.unit("clipboard.write", vec![json!(value)]).await
    }
    pub async fn fetch(&self, url: &str, options: Value) -> Result<Value> {
        self.call("network.fetch", vec![json!(url), options]).await
    }
}
