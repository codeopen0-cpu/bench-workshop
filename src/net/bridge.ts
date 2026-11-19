// A board's web server as a real address on this PC (http://127.0.0.1:<port>/): opened by the
// desktop app's native side (src-tauri/src/lib.rs), or by the dev server while developing
// (vite.config.ts). Requests arrive here; the board's sketch answers them.

export interface WebReq { method: string; path: string; url: string; args: Record<string, string>; body: string; headers: Record<string, string> }
export interface WebResp { status: number; type: string; body: string; headers: Record<string, string> }
type Handler = (req: WebReq) => Promise<WebResp>;

const inTauri = () => '__TAURI_INTERNALS__' in window;
// One set for the whole page: while developing, Vite can load this file again without reloading
// the page, and an old copy still listening (with its own, empty, list of boards) answered "This
// board is not running" before the current one could. Now every copy shares the same list.
const G = ((window as any).__benchBridge ??= { handlers: new Map<string, Handler>(), listening: false }) as { handlers: Map<string, Handler>; listening: boolean };
const handlers = G.handlers;

/** Turn a raw request (url with query, form body) into the board's view of it: path + arguments. */
function toReq(method: string, url: string, headers: Record<string, string>, body: string): WebReq {
  const u = new URL(url, 'http://board');
  const args: Record<string, string> = {};
  u.searchParams.forEach((v, k) => (args[k] = v));
  if (/application\/x-www-form-urlencoded/i.test(headers['content-type'] ?? '')) new URLSearchParams(body).forEach((v, k) => (args[k] = v));
  if (body && !('plain' in args)) args.plain = body; // (ESP32's WebServer puts a raw body in "plain")
  return { method: method.toUpperCase(), path: decodeURIComponent(u.pathname), url: u.pathname + u.search, args, body, headers };
}

async function listen() {
  if (G.listening) return;
  G.listening = true;
  if (inTauri()) {
    const { listen: on } = await import('@tauri-apps/api/event');
    const { invoke } = await import('@tauri-apps/api/core');
    await on<{ id: number; board: string; method: string; url: string; headers: Record<string, string>; body: string }>('bench-http', async (e) => {
      const r = e.payload;
      const h = handlers.get(r.board);
      const a = h ? await h(toReq(r.method, r.url, r.headers, r.body)) : { status: 503, type: 'text/plain', body: 'This board is not running.', headers: {} };
      await invoke('http_respond', { id: r.id, status: a.status, contentType: a.type || 'text/html', headers: a.headers ?? {}, body: a.body ?? '' });
    });
  } else if (import.meta.hot) {
    const hot = import.meta.hot;
    hot.on('bench:http-req', async (r: { id: number; board: string; method: string; url: string; headers: Record<string, string>; body: string }) => {
      const h = handlers.get(r.board);
      const a = h ? await h(toReq(r.method, r.url, r.headers, r.body)) : { status: 503, type: 'text/plain', body: 'This board is not running.', headers: {} };
      hot.send('bench:http-res', { id: r.id, status: a.status, contentType: a.type || 'text/html', headers: a.headers ?? {}, body: a.body ?? '' });
    });
  }
}

/** Open (or reuse) the board's address on this PC. */
export async function openBoardServer(board: string, handler: Handler, fixedPort?: number): Promise<{ port: number; url: string }> {
  await listen();
  handlers.set(board, handler);
  let port: number;
  if (inTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    port = await invoke<number>('http_open', { board, port: fixedPort ?? null });
  } else if (import.meta.hot) {
    const hot = import.meta.hot;
    port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the dev server did not open it')), 5000);
      const got = (m: { board: string; port: number }) => {
        if (m.board !== board) return;
        clearTimeout(t);
        if ((m as any).error) return reject(new Error((m as any).error));
        hot.off?.('bench:http-opened', got);
        resolve(m.port);
      };
      hot.on('bench:http-opened', got);
      hot.send('bench:http-open', { board, port: fixedPort });
    });
  } else throw new Error('board web servers need the desktop app (or the dev server)');
  console.info(`[wifi] ${board}: web server at http://127.0.0.1:${port}/`);
  return { port, url: `http://127.0.0.1:${port}/` };
}

export async function closeBoardServer(board: string) {
  handlers.delete(board);
  try {
    if (inTauri()) (await import('@tauri-apps/api/core')).invoke('http_close', { board });
    else import.meta.hot?.send('bench:http-close', { board });
  } catch { /* already gone */ }
}
