import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { join, normalize } from 'node:path';
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
    server.ws.on('bench:http-open', ({ board }: { board: string }, client) => {
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
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port;
        servers.set(board, { port, srv });
        client.send('bench:http-opened', { board, port });
      });
    });
    server.ws.on('bench:http-res', (a: { id: number; status: number; contentType: string; headers: Record<string, string>; body: string }) => waiting.get(a.id)?.(a));
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
