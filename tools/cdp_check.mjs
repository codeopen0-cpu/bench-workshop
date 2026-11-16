// Checks the running desktop app through WebView2's debugging port (start the app with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333): evaluates an expression in the
// page and saves a screenshot.   node tools/cdp_check.mjs "<js expression>" out.png
import { writeFileSync } from 'node:fs';

const [, , expr = 'document.title', png = 'tools/app_shot.png'] = process.argv;
const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target: ' + JSON.stringify(targets));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
};
const call = (method, params = {}) =>
  new Promise((res) => {
    pending.set(++id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('url:', page.url);
console.log('result:', JSON.stringify(ev.result?.result?.value ?? ev.result, null, 1));
const shot = await call('Page.captureScreenshot', { format: 'png' });
writeFileSync(png, Buffer.from(shot.result.data, 'base64'));
console.log('screenshot:', png);
ws.close();
