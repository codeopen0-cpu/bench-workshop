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
fn http_open(app: tauri::AppHandle, web: State<'_, Arc<Web>>, board: String) -> Result<u16, String> {
    if let Some((port, _)) = web.servers.lock().unwrap().get(&board) {
        return Ok(*port);
    }
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?);
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
        .invoke_handler(tauri::generate_handler![http_open, http_respond, http_close])
        .run(tauri::generate_context!())
        .expect("error while running Bench Workshop");
}
