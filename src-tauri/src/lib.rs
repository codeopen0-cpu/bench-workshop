// Bench Workshop's native shell: one window showing the app (src/, built by Vite), plus file
// dialogs, file access for projects and the libraries folder, opening that folder, GitHub sign-in
// requests, updates, and the boards' web servers (below). Everything else (3D, physics, chips) runs
// in the window.
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, State};

// ------------------------------------------------------------------------------------------------
// Boards with Wi-Fi (an ESP32 running a WebServer sketch) get a real little web server on this PC,
// at http://127.0.0.1:<port>/ (this PC only, never the network). Each request goes to the window as
// a "bench-http" event; the board's sketch answers it there, and the answer comes back through
// http_respond. A board that doesn't answer in 15 s gets a 504.

#[derive(Default)]
struct Web {
    servers: Mutex<HashMap<String, (u16, Arc<tiny_http::Server>)>>,
    waiting: Mutex<HashMap<u64, mpsc::Sender<Answer>>>,
    next: AtomicU64,
}

struct Answer {
    status: u16,
    content_type: String,
    headers: Vec<(String, String)>,
    body: String,
}

#[derive(Clone, serde::Serialize)]
struct WebRequest {
    id: u64,
    board: String,
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: String,
}

fn header(name: &str, value: &str) -> Option<tiny_http::Header> {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()).ok()
}

#[tauri::command]
fn http_open(app: tauri::AppHandle, web: State<'_, Arc<Web>>, board: String, port: Option<u16>) -> Result<u16, String> {
    if let Some((port, _)) = web.servers.lock().unwrap().get(&board) {
        return Ok(*port);
    }
    // (a fixed port when asked: the control API is always at 7420; boards take any free one)
    let server = Arc::new(tiny_http::Server::http(format!("127.0.0.1:{}", port.unwrap_or(0))).map_err(|e| e.to_string())?);
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    web.servers.lock().unwrap().insert(board.clone(), (port, server.clone()));
    let web = web.inner().clone();
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let app = app.clone();
            let web = web.clone();
            let board = board.clone();
            std::thread::spawn(move || {
                let mut body = String::new();
                let _ = req.as_reader().take(1 << 20).read_to_string(&mut body);
                let id = web.next.fetch_add(1, Ordering::Relaxed) + 1;
                let (tx, rx) = mpsc::channel();
                web.waiting.lock().unwrap().insert(id, tx);
                let headers = req.headers().iter().map(|h| (h.field.as_str().as_str().to_ascii_lowercase(), h.value.as_str().to_string())).collect();
                let r = WebRequest { id, board, method: req.method().as_str().to_string(), url: req.url().to_string(), headers, body };
                let answer = if app.emit("bench-http", r).is_ok() { rx.recv_timeout(Duration::from_secs(15)).ok() } else { None };
                web.waiting.lock().unwrap().remove(&id);
                let a = answer.unwrap_or(Answer {
                    status: 504,
                    content_type: "text/plain; charset=utf-8".into(),
                    headers: vec![],
                    body: "The board didn't answer (is the simulation running?)".into(),
                });
                let mut resp = tiny_http::Response::from_string(a.body).with_status_code(a.status);
                for (n, v) in [
                    ("Content-Type", a.content_type.as_str()),
                    ("Cache-Control", "no-store"),
                    // (shown inside the app, which is cross-origin isolated: it must agree to be embedded)
                    ("Cross-Origin-Resource-Policy", "cross-origin"),
                    ("Cross-Origin-Embedder-Policy", "require-corp"),
                ] {
                    if let Some(h) = header(n, v) {
                        resp.add_header(h);
                    }
                }
                for (n, v) in a.headers {
                    let low = n.to_ascii_lowercase();
                    if low == "content-type" || low.starts_with("cross-origin") || low == "content-length" {
                        continue;
                    }
                    if let Some(h) = header(&n, &v) {
                        resp.add_header(h);
                    }
                }
                let _ = req.respond(resp);
            });
        }
    });
    Ok(port)
}

#[tauri::command]
fn http_respond(web: State<'_, Arc<Web>>, id: u64, status: u16, content_type: String, headers: HashMap<String, String>, body: String) {
    if let Some(tx) = web.waiting.lock().unwrap().remove(&id) {
        let _ = tx.send(Answer { status, content_type, headers: headers.into_iter().collect(), body });
    }
}

#[tauri::command]
fn http_close(web: State<'_, Arc<Web>>, board: String) {
    if let Some((_, server)) = web.servers.lock().unwrap().remove(&board) {
        server.unblock();
    }
}

// ------------------------------------------------------------------------------------------------
// Uploading a sketch to a real board: through arduino-cli (on its own, or the one inside the Arduino
// IDE). The window writes the sketch to a temporary folder, then runs arduino-cli (compile, upload,
// board list, core install when the user clicks for it); its output comes back line by line as
// "bench-ardu" events. Nothing but arduino-cli can be run this way.

fn ardu_candidates() -> Vec<std::path::PathBuf> {
    let mut out = vec![];
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            out.push(dir.join(if cfg!(windows) { "arduino-cli.exe" } else { "arduino-cli" }));
        }
    }
    let ide = ["resources", "app", "lib", "backend", "resources", "arduino-cli.exe"];
    let mut roots = vec![];
    if let Some(p) = std::env::var_os("ProgramFiles") {
        roots.push(std::path::PathBuf::from(p).join("Arduino IDE"));
    }
    if let Some(p) = std::env::var_os("LOCALAPPDATA") {
        roots.push(std::path::PathBuf::from(p).join("Programs").join("Arduino IDE"));
    }
    for r in roots {
        out.push(ide.iter().fold(r, |acc, part| acc.join(part)));
    }
    if cfg!(target_os = "macos") {
        out.push("/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli".into());
    }
    out
}

#[tauri::command]
fn ardu_find() -> Option<String> {
    ardu_candidates().into_iter().find(|p| p.is_file()).map(|p| p.to_string_lossy().to_string())
}

/** the sketch as a folder arduino-cli can build: <temp>/bench-workshop-sketches/<name>/<name>.ino */
#[tauri::command]
fn ardu_sketch(name: String, source: String) -> Result<String, String> {
    let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
    let clean = if clean.is_empty() { "sketch".to_string() } else { clean };
    let dir = std::env::temp_dir().join("bench-workshop-sketches").join(&clean);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.ino", clean)), source).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(Clone, serde::Serialize)]
struct ArduLine {
    job: String,
    line: String,
    err: bool,
}

#[tauri::command]
async fn ardu_run(app: tauri::AppHandle, exe: String, args: Vec<String>, job: String) -> Result<i32, String> {
    // (only arduino-cli: the window can't be made to run anything else)
    let file = std::path::Path::new(&exe).file_name().map(|f| f.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if file != "arduino-cli.exe" && file != "arduino-cli" {
        return Err("not arduino-cli".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::BufRead;
        let mut cmd = std::process::Command::new(&exe);
        cmd.args(&args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
        }
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let out = child.stdout.take().unwrap();
        let err = child.stderr.take().unwrap();
        let (a1, j1) = (app.clone(), job.clone());
        let t = std::thread::spawn(move || {
            for line in std::io::BufReader::new(err).lines().map_while(Result::ok) {
                let _ = a1.emit("bench-ardu", ArduLine { job: j1.clone(), line, err: true });
            }
        });
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            let _ = app.emit("bench-ardu", ArduLine { job: job.clone(), line, err: false });
        }
        let _ = t.join();
        let status = child.wait().map_err(|e| e.to_string())?;
        Ok(status.code().unwrap_or(-1))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::new(Web::default()))
        .invoke_handler(tauri::generate_handler![http_open, http_respond, http_close, ardu_find, ardu_sketch, ardu_run])
        .run(tauri::generate_context!())
        .expect("error while running Bench Workshop");
}
