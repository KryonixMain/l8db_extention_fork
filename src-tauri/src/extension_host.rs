use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

const MAX_LINE: usize = 1024 * 1024;
const MAX_HOSTS: usize = 16;
const OUTBOX_CAPACITY: usize = 256;
const MAX_STDERR_LINE: usize = 4096;

static SESSIONS: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct NativeHostState(Mutex<HashMap<String, Host>>);

struct Host {
    session: u64,
    outbox: mpsc::Sender<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HostEvent {
    session: u64,
    message: Value,
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id.bytes.all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
        && !id.contains("..")
}

fn channel(id: &str) -> String {
    format!("extension-host://{id}")
}

fn base_directory(
    app: &AppHandle,
    id: &str,
    development_path: Option<&str>,
) -> Result<PathBuf, String> {
    let base = match development_path {
        Some(path) => PathBuf::from(path),
        None => tauri::Manager::path(app).app_data_dir().map_err(|e| e.to_string())?.join("community-extensions").join(id),
    };
    base.canonicalize().map_err(|e| e.to_string())
}

pub(crate) fn current_platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn select_executable(executables: &HashMap<String, String>) -> Result<&String, String> {
    let platform = current_platform();
    executables.get(&platform).ok_or(format!(
        "Extension ships no executable for {platform}; available: {}",
        {
            let mut keys: Vec<&str> = executables.keys().map(String::as_str).collect();
            keys.sort_unstable();
            keys.join(", ")
        }
    ))
}

fn resolve_program(base: &Path, executable: &str) -> Result<PathBuf, String> {
    if !crate::community_extensions::safe_path(executable) {
        return Err("Invalid extension executable path".into());
    }
    let resolved = base.join(executable).canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(base) {
        return Err("Extension executable must stay inside the extension directory".into());
    }
    let metadata = std::fs::symlink_metadata(&resolved).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Extension executable must not be a symlink".into());
    }
    if !metadata.is_file() {
        return Err("Extension executable must be a regular file".into());
    }
    Ok(resolved)
}

fn emit(app: &AppHandle, id: &str, session: u64, message: Value) {
    let _ = app.emit(&channel(id), HostEvent { session, message });
}

fn forget(app: &AppHandle, id: &str, session: u64) {
    let state: State<'_, NativeHostState> = tauri::Manager::state(app);
    let Ok(mut hosts) = state.0.lock() else { return };
    if hosts.get(id).is_some_and(|host| host.session == session) {
        hosts.remove(id);
    }
}

fn crash(app: &AppHandle, id: &str, session: u64, error: String) {
    emit(
        app,
        id,
        session,
        serde_json::json!({ "type": "crash", "error": error }),
    );
}

async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> Result<Option<String>, String> {
    let mut buffer = Vec::new();
    loop {
        let available = match reader.fill_buf().await {
            Ok(chunk) => chunk,
            Err(error) => return Err(error.to_string()),
        };
        if available.is_empty() {
            if buffer.is_empty() {
                return Ok(None);
            }
            break;
        }
        match available.iter().position(|byte| *byte == b'\n') {
            Some(index) => {
                buffer.extend_from_slice(&available[..index]);
                reader.consume(index + 1);
                break;
            }
            None => {
                let length = available.len();
                buffer.extend_from_slice(available);
                reader.consume(length);
            }
        }
        if buffer.len() > limit {
            return Err("Extension message exceeds the line limit".into());
        }
    }
    if buffer.len() > limit {
        return Err("Extension message exceeds the line limit".into());
    }
    if buffer.last() == Some(&b'\r') {
        buffer.pop();
    }
    Ok(Some(String::from_utf8_lossy(&buffer).into_owned()))
}

#[tauri::command(async)]
pub async fn extension_host_spawn(
    app: AppHandle,
    state: State<'_, NativeHostState>,
    id: String,
    executables: HashMap<String, String>,
    args: Vec<String>,
    development_path: Option<String>,
) -> Result<u64, String> {
    if !safe_id(&id) {
        return Err("Invalid extension id".into());
    }
    if args.len() > 32 || args.iter().any(|arg| arg.len() > 4096 || arg.contains('\0')) {
        return Err("Invalid extension arguments".into());
    }
    let executable = select_executable(&executables)?.clone();
    let cwd = base_directory(&app, &id, development_path.as_deref())?;
    let program = resolve_program(&cwd, &executable)?;
    {
        let hosts = state.0.lock().map_err(|e| e.to_string())?;
        if hosts.contains_key(&id) {
            return Err("Extension host already running".into());
        }
        if hosts.len() >= MAX_HOSTS {
            return Err("Too many native extension hosts".into());
        }
    }
    let session = SESSIONS.fetch_add(1, Ordering::Relaxed) + 1;
    let mut child = tokio::process::Command::new(&program).args(&args).current_dir(&cwd).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true).spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("Extension stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("Extension stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Extension stderr unavailable")?;
    let (outbox, mut inbox) = mpsc::channel::<String>(OUTBOX_CAPACITY);
    state.0.lock().map_err(|e| e.to_string())?.insert(id.clone(), Host { session, outbox });

    let reader_app = app.clone();
    let reader_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_line(&mut reader, MAX_LINE).await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(&line) {
                        Ok(message) => emit(&reader_app, &reader_id, session, message),
                        Err(error) => {
                            crash(
                                &reader_app,
                                &reader_id,
                                session,
                                format!("Malformed extension message: {error}"),
                            );
                            break;
                        }
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    crash(&reader_app, &reader_id, session, error);
                    break;
                }
            }
        }
    });

    let stderr_app = app.clone();
    let stderr_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr);
        while let Ok(Some(line)) = read_line(&mut reader, MAX_STDERR_LINE).await {
            if line.trim().is_empty() {
                continue;
            }
            emit(
                &stderr_app,
                &stderr_id,
                session,
                serde_json::json!({ "type": "stderr", "line": line }),
            );
        }
    });

    let supervisor_app = app.clone();
    let supervisor_id = id.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                outgoing = inbox.recv() => {
                    let Some(line) = outgoing else { break };
                    if stdin.write_all(line.as_bytes()).await.is_err()
                        || stdin.write_all(b"\n").await.is_err()
                        || stdin.flush().await.is_err()
                    {
                        break;
                    }
                }
                exit = child.wait() => {
                    let reason = match exit {
                        Ok(status) => format!("Extension host exited with {status}"),
                        Err(error) => format!("Extension host failed: {error}"),
                    };
                    forget(&supervisor_app, &supervisor_id, session);
                    crash(&supervisor_app, &supervisor_id, session, reason);
                    return;
                }
            }
        }
        let _ = child.start_kill();
        let _ = child.wait().await;
        forget(&supervisor_app, &supervisor_id, session);
    });
    Ok(session)
}

#[tauri::command(async)]
pub async fn extension_host_send(
    state: State<'_, NativeHostState>,
    id: String,
    message: String,
) -> Result<(), String> {
    if message.len() > MAX_LINE {
        return Err("Extension message exceeds the line limit".into());
    }
    if message.contains('\n') {
        return Err("Extension message must be a single line".into());
    }
    let outbox = {
        let hosts = state.0.lock().map_err(|e| e.to_string())?;
        hosts.get(&id).ok_or("Extension host is not running")?.outbox.clone()
    };
    outbox.send(message).await.map_err(|_| "Extension host is not running".to_string())
}

#[tauri::command(async)]
pub async fn extension_host_kill(
    state: State<'_, NativeHostState>,
    id: String,
) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[tauri::command(async)]
pub async fn extension_host_session(
    state: State<'_, NativeHostState>,
    id: String,
) -> Result<Option<u64>, String> {
    Ok(state.0.lock.map_err(|e| e.to_string())?.get(&id).map(|host| host.session))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_ids() {
        assert!(safe_id("publisher.name"));
        assert!(!safe_id("../escape"));
        assert!(!safe_id(""));
        assert!(!safe_id("has/slash"));
    }

    #[test]
    fn selects_the_executable_for_the_current_platform() {
        let mut executables = HashMap::new();
        assert!(select_executable(&executables).is_err());
        executables.insert(current_platform(), "bin/demo".to_string());
        assert_eq!(select_executable(&executables).unwrap(), "bin/demo");
    }

    #[test]
    fn rejects_unsafe_executable_paths() {
        assert!(resolve_program(Path::new("/tmp"), "../escape").is_err());
        assert!(resolve_program(Path::new("/tmp"), "/abs").is_err());
    }

    #[tokio::test]
    async fn reads_lines_and_strips_carriage_returns() {
        let data: &[u8] = b"first\nsecond\r\n";
        let mut reader = BufReader::new(data);
        assert_eq!(
            read_line(&mut reader, 64).await.unwrap().as_deref(),
            Some("first")
        );
        assert_eq!(
            read_line(&mut reader, 64).await.unwrap().as_deref(),
            Some("second")
        );
        assert_eq!(read_line(&mut reader, 64).await.unwrap(), None);
    }

    #[tokio::test]
    async fn returns_trailing_line_without_newline() {
        let data: &[u8] = b"tail";
        let mut reader = BufReader::new(data);
        assert_eq!(
            read_line(&mut reader, 64).await.unwrap().as_deref(),
            Some("tail")
        );
        assert_eq!(read_line(&mut reader, 64).await.unwrap(), None);
    }

    #[tokio::test]
    async fn rejects_oversized_lines() {
        let payload = vec![b'x'; 4096];
        let mut reader = BufReader::new(payload.as_slice());
        assert!(read_line(&mut reader, 16).await.is_err());
    }

    #[tokio::test]
    async fn accepts_a_line_exactly_at_the_limit() {
        let mut payload = vec![b'x'; 16];
        payload.push(b'\n');
        let mut reader = BufReader::new(payload.as_slice());
        assert_eq!(read_line(&mut reader, 16).await.unwrap().unwrap().len(), 16);
    }
}
