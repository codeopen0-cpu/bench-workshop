import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, normalize } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// The library list (registry/) while developing: the app reads /registry/index.json. Not part of the
// built app: the released app reads the list from where it's published.
const registry = (): Plugin => ({
  name: 'bench-registry',
  configureServer(server) {
    const root = join(__dirname, 'registry');
    server.middlewares.use('/registry', (req, res, next) => {
      const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^[/\\]+/, '');
      const file = join(root, rel);
      // only the list itself: the app imports registry/tools/safety.mjs as code, through Vite
      if (!file.startsWith(root) || !existsSync(file) || !(rel === 'index.json' || rel.startsWith('libraries'))) return next();
      res.setHeader('Content-Type', file.endsWith('.json') || file.endsWith('.benchlib') ? 'application/json' : 'text/plain');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(readFileSync(file));
    });
  },
});

// Boards' web servers while developing (the desktop app does this natively, src-tauri/src/lib.rs):
// a little HTTP server per board on 127.0.0.1, whose requests go to the page over Vite's socket and
// are answered by the board's sketch there.
const boardWeb = (): Plugin => ({
  name: 'bench-board-web',
  configureServer(server) {
    const servers = new Map<string, { port: number; srv: HttpServer }>();
    const waiting = new Map<number, (a: { status: number; contentType: string; headers: Record<string, string>; body: string }) => void>();
    let next = 0;
    server.ws.on('bench:http-open', ({ board, port: want }: { board: string; port?: number }, client) => {
      const have = servers.get(board);
      if (have) return client.send('bench:http-opened', { board, port: have.port });
      const srv = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body = (body + c).slice(0, 1 << 20)));
        req.on('end', () => {
          const id = ++next;
          const timer = setTimeout(() => done({ status: 504, contentType: 'text/plain', headers: {}, body: "The board didn't answer (is the simulation running?)" }), 15000);
          const done = (a: { status: number; contentType: string; headers: Record<string, string>; body: string }) => {
            clearTimeout(timer);
            waiting.delete(id);
            if (res.headersSent) return;
            const h: Record<string, string> = {};
            for (const [n, v] of Object.entries(a.headers ?? {})) if (!/^(content-type|content-length|cross-origin)/i.test(n)) h[n] = v;
            res.writeHead(a.status, { ...h, 'Content-Type': a.contentType, 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
            res.end(a.body);
          };
          waiting.set(id, done);
          server.ws.send('bench:http-req', { id, board, method: req.method, url: req.url, headers: req.headers, body });
        });
      });
      srv.on('error', (e) => client.send('bench:http-opened', { board, port: 0, error: String(e) }));
      srv.listen(want ?? 0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port;
        servers.set(board, { port, srv });
        client.send('bench:http-opened', { board, port });
      });
    });
    server.ws.on('bench:http-res', (a: { id: number; status: number; contentType: string; headers: Record<string, string>; body: string }) => waiting.get(a.id)?.(a));
    // real boards (src/ui/realboard.ts): arduino-cli, as the desktop app runs it (src-tauri/src/lib.rs)
    server.ws.on('bench:ardu', async (m: { id: string; op: string; name?: string; source?: string; exe?: string; args?: string[]; job?: string }, client) => {
      const done = (result?: unknown, error?: string) => client.send('bench:ardu-done', { id: m.id, result, error });
      try {
        if (m.op === 'find') {
          const cands = [
            ...(process.env.PATH ?? '').split(delimiter).map((d) => join(d, process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli')),
            join(process.env.ProgramFiles ?? 'C:/Program Files', 'Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe'),
            join(process.env.LOCALAPPDATA ?? '', 'Programs/Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe'),
          ];
          return done(cands.find((c) => existsSync(c)) ?? null);
        }
        if (m.op === 'sketch') {
          const name = (m.name ?? 'sketch').replace(/[^A-Za-z0-9_]/g, '_') || 'sketch';
          const dir = join(tmpdir(), 'bench-workshop-sketches', name);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${name}.ino`), m.source ?? '');
          return done(dir);
        }
        if (m.op === 'run') {
          if (!/^arduino-cli(\.exe)?$/i.test(basename(m.exe ?? ''))) return done(undefined, 'not arduino-cli');
          const child = spawn(m.exe!, m.args ?? [], { windowsHide: true });
          const pipe = (s: NodeJS.ReadableStream, err: boolean) => {
            let buf = '';
            s.on('data', (c) => {
              buf += c;
              const lines = buf.split(/\r?\n/);
              buf = lines.pop()!;
              for (const line of lines) client.send('bench:ardu-line', { job: m.job, line, err });
            });
            s.on('end', () => buf && client.send('bench:ardu-line', { job: m.job, line: buf, err }));
          };
          pipe(child.stdout, false);
          pipe(child.stderr, true);
          child.on('error', (e) => done(undefined, String(e)));
          child.on('close', (code) => done(code ?? -1));
        }
      } catch (e) {
        done(undefined, String(e));
      }
    });
    server.ws.on('bench:http-close', ({ board }: { board: string }) => {
      servers.get(board)?.srv.close();
      servers.delete(board);
    });
  },
});

// Tauri serves the built files itself; in development it loads this dev server.
// The cross-origin headers turn on SharedArrayBuffer, which the sketch and chip-emulator workers
// use to share pin states with the simulation (the Tauri app sets the same headers, see tauri.conf.json).
export default defineConfig({
  clearScreen: false,
  plugins: [registry(), boardWeb()],
  server: {
    port: 1420,
    // GitHub's device sign-in pages don't allow pages to call them; in development they go through
    // here (the desktop app calls them from its native side instead)
    proxy: { '/gh-login': { target: 'https://github.com', changeOrigin: true, rewrite: (p) => p.replace(/^.gh-login/, '/login') } },
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // (BENCH_STILL=1: no reloading when files change, for the example check's own server: editing
    //  the source while it runs must not restart the page under it)
    ...(process.env.BENCH_STILL ? { hmr: false, watch: null } : {}),
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  // the app's version, for libraries that need a newer one ("needsApp" in a library)
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version) },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 6000,
  },
  worker: { format: 'es' },
});
