// Put the sketch on a REAL board: arduino-cli (on its own, or the one that comes with the Arduino IDE)
// compiles it and uploads it over USB. The window picks the matching real board for the bench's one,
// lists the USB ports, and says plainly when a board's support (its "core") isn't installed yet:
// installing it downloads it, so that only happens when the user clicks for it.

const inTauri = () => '__TAURI_INTERNALS__' in window;

/** the boards' support packages, and where the ones not built into arduino-cli are listed */
const CORES: Record<string, { name: string; url?: string; size: string }> = {
  'arduino:avr': { name: 'Arduino AVR boards (UNO, Nano, Mega)', size: 'about 60 MB' },
  'arduino:renesas_uno': { name: 'Arduino UNO R4 boards', size: 'about 400 MB' },
  'esp32:esp32': { name: 'ESP32 boards (Espressif)', url: 'https://espressif.github.io/arduino-esp32/package_esp32_index.json', size: 'about 1 GB' },
  'esp8266:esp8266': { name: 'ESP8266 boards', url: 'https://arduino.esp8266.com/stable/package_esp8266com_index.json', size: 'about 200 MB' },
  'rp2040:rp2040': { name: 'Raspberry Pi Pico / RP2040 boards (Earle Philhower)', url: 'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json', size: 'about 400 MB' },
};

/** the real board for each bench board */
export const BOARD_FQBN: Record<string, string> = {
  'arduino-nano': 'arduino:avr:nano',
  'arduino-mega': 'arduino:avr:mega',
  'uno-wifi-board': 'arduino:renesas_uno:unor4wifi',
  'esp32-board': 'esp32:esp32:esp32',
  'esp32s3-board': 'esp32:esp32:esp32s3',
  'esp32c3-mini': 'esp32:esp32:esp32c3',
  'esp8266-nodemcu': 'esp8266:esp8266:nodemcuv2',
  'esp8266-d1mini': 'esp8266:esp8266:d1_mini',
  'pico-w': 'rp2040:rp2040:rpipicow',
  'maker-board': 'rp2040:rp2040:rpipico',
  'rp2040-board': 'rp2040:rp2040:rpipico',
};
const CHOICES: [string, string][] = [
  ['arduino:avr:uno', 'Arduino UNO (R3)'], ['arduino:avr:nano', 'Arduino Nano'], ['arduino:avr:mega', 'Arduino Mega 2560'],
  ['arduino:renesas_uno:unor4wifi', 'Arduino UNO R4 WiFi'], ['arduino:renesas_uno:minima', 'Arduino UNO R4 Minima'],
  ['esp32:esp32:esp32', 'ESP32 Dev Module'], ['esp32:esp32:esp32s3', 'ESP32-S3 Dev Module'], ['esp32:esp32:esp32c3', 'ESP32-C3 Dev Module'],
  ['esp8266:esp8266:nodemcuv2', 'NodeMCU 1.0 (ESP8266)'], ['esp8266:esp8266:d1_mini', 'LOLIN D1 mini (ESP8266)'],
  ['rp2040:rp2040:rpipico', 'Raspberry Pi Pico'], ['rp2040:rp2040:rpipicow', 'Raspberry Pi Pico W'],
];

// ------------------------------------------------------------------------------- running arduino-cli
type Line = (line: string, err: boolean) => void;
interface Runner {
  find(): Promise<string | null>;
  sketch(name: string, source: string): Promise<string>;
  run(exe: string, args: string[], onLine: Line): Promise<number>;
}
let jobs = 0;
const tauriRunner: Runner = {
  async find() { return (await import('@tauri-apps/api/core')).invoke<string | null>('ardu_find'); },
  async sketch(name, source) { return (await import('@tauri-apps/api/core')).invoke<string>('ardu_sketch', { name, source }); },
  async run(exe, args, onLine) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    const job = `j${++jobs}`;
    const off = await listen<{ job: string; line: string; err: boolean }>('bench-ardu', (e) => e.payload.job === job && onLine(e.payload.line, e.payload.err));
    try { return await invoke<number>('ardu_run', { exe, args, job }); } finally { off(); }
  },
};
/** (while developing: the dev server runs it, see vite.config.ts) */
const devRunner: Runner = {
  find: () => devAsk('find', {}),
  sketch: (name, source) => devAsk('sketch', { name, source }),
  run(exe, args, onLine) {
    const hot = import.meta.hot!;
    const job = `j${++jobs}`;
    const got = (m: { job: string; line: string; err: boolean }) => m.job === job && onLine(m.line, m.err);
    hot.on('bench:ardu-line', got);
    return devAsk<number>('run', { exe, args, job }).finally(() => hot.off?.('bench:ardu-line', got));
  },
};
function devAsk<T>(op: string, data: object): Promise<T> {
  const hot = import.meta.hot;
  if (!hot) return Promise.reject(new Error('real boards need the desktop app'));
  const id = `${op}${++jobs}`;
  return new Promise((resolve, reject) => {
    const got = (m: { id: string; result?: T; error?: string }) => {
      if (m.id !== id) return;
      hot.off?.('bench:ardu-done', got);
      if (m.error) reject(new Error(m.error)); else resolve(m.result as T);
    };
    hot.on('bench:ardu-done', got);
    hot.send('bench:ardu', { id, op, ...data });
  });
}
const runner = () => (inTauri() ? tauriRunner : devRunner);

// ----------------------------------------------------------------------------------------- the window
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'style') e.setAttribute('style', v); else (e as any)[k] = v; }
  e.append(...kids);
  return e;
}

export interface RealBoardHost {
  /** the bench board: its uid, type, name and program */
  board: { uid: string; type: string; name: string; source: string; lang: string };
  log(msg: string, level?: 'info' | 'warn' | 'bad'): void;
}

export async function openRealBoard(host: RealBoardHost) {
  const b = host.board;
  const back = el('div', { className: 'modal-back' });
  let busy = false;
  const close = () => { if (busy) return; back.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
  document.addEventListener('keydown', esc);
  back.onclick = (e) => e.target === back && close();

  const out = el('pre', { className: 'rb-out' });
  const say = (t: string, cls = '') => { const s = el('span', { className: cls, textContent: t + '\n' }); out.append(s); out.scrollTop = out.scrollHeight; };
  const fq = el('select', { className: 'rb-select' }) as HTMLSelectElement;
  const want = BOARD_FQBN[b.type] ?? 'arduino:avr:uno';
  for (const [v, label] of CHOICES) fq.append(el('option', { value: v, textContent: `${label}  (${v})` }));
  if (!CHOICES.some(([v]) => v === want)) fq.append(el('option', { value: want, textContent: want }));
  fq.append(el('option', { value: '__other', textContent: 'Other (type its FQBN)...' }));
  fq.value = want;
  const other = el('input', { type: 'text', placeholder: 'vendor:arch:board', className: 'rb-other', hidden: true }) as HTMLInputElement;
  fq.onchange = () => { other.hidden = fq.value !== '__other'; void checkCore(); };
  const port = el('select', { className: 'rb-select' }) as HTMLSelectElement;
  const coreNote = el('div', { className: 'rb-note' });
  const btnCompile = el('button', { textContent: 'Check it compiles' }) as HTMLButtonElement;
  const btnUpload = el('button', { className: 'primary', textContent: 'Upload' }) as HTMLButtonElement;
  const btnPorts = el('button', { textContent: 'Find ports', title: 'Look again for boards plugged in by USB' }) as HTMLButtonElement;
  const fqbn = () => (fq.value === '__other' ? other.value.trim() : fq.value);
  const coreOf = (f: string) => f.split(':').slice(0, 2).join(':');

  const win = el('div', { className: 'modal rb-window' },
    el('div', { className: 'modal-head' },
      el('div', { className: 'modal-title', textContent: `${b.name}: put it on a real board` }),
      el('div', { className: 'modal-sub', textContent: 'Compiles the program with arduino-cli and uploads it over USB.' }),
      el('button', { className: 'modal-x', textContent: '×', title: 'Close (Esc)', onclick: close })),
    el('div', { className: 'rb-body' },
      el('label', { className: 'rb-row' }, el('span', { textContent: 'Real board' }), fq, other),
      el('label', { className: 'rb-row' }, el('span', { textContent: 'USB port' }), port, btnPorts),
      coreNote,
      out),
    el('div', { className: 'lib-foot' }, btnCompile, el('span', { style: 'flex:1' }), btnUpload));
  back.append(win);
  document.body.append(back);

  // the program as it will go on the board, and a word about things the bench does differently
  if (b.lang !== 'arduino') say('This board\'s program is in JavaScript: only Arduino C++ goes on a real board (switch the language in the program editor).', 'bad');
  if (/"Workshop"\s*,\s*"bench1234"|WiFi\.begin\(\s*"Workshop"/.test(b.source)) say('Note: it joins the bench\'s Wi-Fi ("Workshop"). Change the name and password in WiFi.begin to your own network\'s before uploading.', 'warn');

  const r = runner();
  let exe: string | null = null;
  try { exe = await r.find(); } catch (e: any) { say(e.message, 'bad'); }
  if (!exe) {
    say('arduino-cli was not found. Install the Arduino IDE (it includes it) from arduino.cc/en/software, or put arduino-cli on your PATH, then open this again.', 'bad');
    btnCompile.disabled = btnUpload.disabled = btnPorts.disabled = true;
    return;
  }
  say(`using ${exe}`, 'dim');
  const cli = (args: string[], show = true) => {
    const lines: string[] = [];
    console.info(`[realboard] arduino-cli ${args.join(' ')}`);
    return r.run(exe!, args, (line, err) => {
      lines.push(line);
      // (download progress redraws itself with carriage returns: show where it ended up)
      // (and without its terminal colour codes)
      const shown = (line.split('\r').filter((x) => x.trim()).pop() ?? '').replace(/\u001b\[[0-9;]*m/g, '');
      if (show && shown) say(shown, err ? 'err' : '');
    }).then((code) => ({ code, text: lines.join('\n') }));
  };
  const lock = async <T>(f: () => Promise<T>) => {
    busy = true;
    btnCompile.disabled = btnUpload.disabled = btnPorts.disabled = true;
    try { return await f(); } finally { busy = false; btnCompile.disabled = btnUpload.disabled = btnPorts.disabled = false; }
  };

  let installed = new Set<string>();
  const checkCore = async () => {
    coreNote.replaceChildren();
    const core = coreOf(fqbn());
    if (!core.includes(':')) return;
    if (installed.has(core)) { coreNote.textContent = `${CORES[core]?.name ?? core}: installed.`; return; }
    const info = CORES[core];
    const btn = el('button', {
      textContent: `Install ${info?.name ?? core}`,
      title: `Downloads it from ${info?.url ? new URL(info.url).host : 'downloads.arduino.cc'} (${info?.size ?? 'size varies'}); this can take a few minutes`,
      onclick: () => lock(async () => {
        say(`installing ${core} (${info?.size ?? 'size varies'})...`, 'dim');
        const extra = info?.url ? ['--additional-urls', info.url] : [];
        await cli(['core', 'update-index', ...extra]);
        const res = await cli(['core', 'install', core, ...extra]);
        say(res.code === 0 ? `${core} installed` : `installing ${core} failed (exit ${res.code})`, res.code === 0 ? 'ok' : 'bad');
        host.log(res.code === 0 ? `real boards: ${core} installed` : `real boards: installing ${core} failed`, res.code === 0 ? 'info' : 'bad');
        await loadCores();
      }),
    });
    coreNote.append(el('span', { textContent: `${info?.name ?? core} isn't installed yet. ` }), btn, el('span', { className: 'dim', textContent: ` downloads ${info?.size ?? 'it'}` }));
  };
  const loadCores = async () => {
    const res = await cli(['core', 'list', '--format', 'json'], false);
    try {
      const j = JSON.parse(res.text);
      installed = new Set((j.platforms ?? j ?? []).map((p: any) => p.id ?? p.ID).filter(Boolean));
    } catch { installed = new Set(); }
    console.info(`[realboard] cores: ${[...installed].join(', ') || 'none'}`);
    await checkCore();
  };
  const loadPorts = async () => {
    const res = await cli(['board', 'list', '--format', 'json'], false);
    port.replaceChildren();
    let found: { address: string; label: string; board?: string; fqbn?: string }[] = [];
    try {
      const j = JSON.parse(res.text);
      found = (j.detected_ports ?? j ?? []).map((d: any) => ({
        address: d.port?.address ?? d.address, label: d.port?.protocol_label ?? '',
        board: d.matching_boards?.[0]?.name, fqbn: d.matching_boards?.[0]?.fqbn,
      })).filter((p: any) => p.address);
    } catch { /* none */ }
    for (const p of found) port.append(el('option', { value: p.address, textContent: `${p.address}${p.board ? `  ${p.board}` : p.label ? `  (${p.label})` : ''}` }));
    if (!found.length) port.append(el('option', { value: '', textContent: 'no USB ports: plug the board in, then Find ports' }));
    // a port that says which board it is: that one
    const known = found.find((p) => p.fqbn && coreOf(p.fqbn) === coreOf(fqbn())) ?? found.find((p) => p.board);
    if (known) port.value = known.address;
    console.info(`[realboard] ports: ${found.map((p) => `${p.address}${p.board ? '=' + p.board : ''}`).join(', ') || 'none'}`);
  };

  const compile = async (upload: boolean) => {
    const f = fqbn();
    if (!/^[\w.-]+:[\w.-]+:[\w.-]+/.test(f)) return say('Pick the real board (vendor:arch:board).', 'bad');
    if (!installed.has(coreOf(f))) return say(`Install ${CORES[coreOf(f)]?.name ?? coreOf(f)} first (the button above).`, 'bad');
    if (upload && !port.value) return say('Plug the board in by USB, then Find ports.', 'bad');
    out.replaceChildren();
    const name = (b.name.replace(/[^A-Za-z0-9_]/g, '_') || 'sketch').slice(0, 40);
    const dir = await r.sketch(name, b.source);
    say(`${upload ? 'compiling and uploading' : 'compiling'} for ${f}${upload ? ` on ${port.value}` : ''}...`, 'dim');
    const t0 = performance.now();
    // (no board lists here: an installed core needs none, and they'd be downloaded again each time)
    const res = await cli(['compile', '--fqbn', f, ...(upload ? ['--upload', '--port', port.value] : []), dir]);
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    if (res.code === 0) {
      say(upload ? `uploaded in ${s} s: it's running on the board now` : `it compiles (${s} s)`, 'ok');
      host.log(upload ? `${b.name}: uploaded to the real board on ${port.value}` : `${b.name}: compiles for ${f}`);
    } else {
      // a library the sketch includes isn't installed: say which, and how
      const missing = [...res.text.matchAll(/fatal error: ([\w./-]+\.h): No such file/g)].map((m) => m[1]);
      if (missing.length) say(`Missing: ${[...new Set(missing)].join(', ')}. Install the library that has it in the Arduino IDE (Tools > Manage Libraries), then try again.`, 'bad');
      say(upload ? `upload failed (exit ${res.code})` : `it doesn't compile (exit ${res.code})`, 'bad');
      host.log(`${b.name}: ${upload ? 'upload' : 'compile'} for ${f} failed`, 'warn');
    }
    console.info(`[realboard] ${upload ? 'upload' : 'compile'} ${f}: exit ${res.code} in ${s} s`);
  };
  btnCompile.onclick = () => lock(() => compile(false));
  btnUpload.onclick = () => lock(() => compile(true));
  btnPorts.onclick = () => lock(loadPorts);
  await lock(async () => { await loadCores(); await loadPorts(); });
}
