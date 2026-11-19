// The program dock under the 3D view: a code editor (Monaco, loaded the first time it opens) for the
// selected board's program, and its serial monitor.
import type * as Monaco from 'monaco-editor';
import type { Program } from '../project';

export const DEFAULT_JS = `// Blink: the board's own LED (and an LED on GP7) on and off every half second.
// setup() runs once, loop() runs over and over. delay() waits in simulated time.

function setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(7, OUTPUT);
  Serial.begin(115200);
  Serial.println("Hello from the bench!");
}

function loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(7, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  digitalWrite(7, LOW);
  delay(500);
}
`;

export const DEFAULT_ARDUINO = `// Blink, as an Arduino sketch (C++). The app turns simple sketches into its own code.
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("Hello from the bench!");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`;

// Autocomplete and hover help for the program API (JavaScript mode).
const API_DTS = `
declare const HIGH: 1, LOW: 0, INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2, INPUT_PULLDOWN: 3, LED_BUILTIN: number;
declare const A0: number, A1: number, A2: number, A3: number, SDA: number, SCL: number;
/** Set a pin to INPUT, OUTPUT, INPUT_PULLUP or INPUT_PULLDOWN. */ declare function pinMode(pin: number, mode: number): void;
/** HIGH (3.3 V) or LOW (0 V) on an OUTPUT pin. */ declare function digitalWrite(pin: number, value: number | boolean): void;
/** 1 or 0. */ declare function digitalRead(pin: number): number;
/** 0-4095 for 0-3.3 V (analog pins only). */ declare function analogRead(pin: number): number;
/** PWM: 0-255 (change with analogWriteResolution). */ declare function analogWrite(pin: number, value: number): void;
declare function analogWriteResolution(bits: number): void; declare function analogWriteFreq(hz: number): void;
declare function tone(pin: number, hz: number, ms?: number): void; declare function noTone(pin: number): void;
/** Wait, in simulated time. */ declare function delay(ms: number): void; declare function delayMicroseconds(us: number): void;
/** Simulated time since the run started. */ declare function millis(): number; declare function micros(): number;
/** How long the pin stays at level (us), e.g. an HC-SR04's ECHO. 0 = timed out. */ declare function pulseIn(pin: number, level: number, timeoutUs?: number): number;
declare function map(x: number, inMin: number, inMax: number, outMin: number, outMax: number): number;
declare function constrain(x: number, lo: number, hi: number): number; declare function random(maxOrMin: number, max?: number): number;
declare const Serial: { begin(baud?: number): void; print(x: any, fmt?: number): void; println(x?: any, fmt?: number): void; printf(fmt: string, ...a: any[]): void; available(): number; read(): number; readStringUntil(c: string): string; };
declare const Wire: { begin(): void; beginTransmission(addr: number): void; write(b: number | number[]): number; endTransmission(): number; requestFrom(addr: number, n: number): number; available(): number; read(): number; };
declare class Servo { attach(pin: number, minUs?: number, maxUs?: number): number; write(angleOrUs: number): void; writeMicroseconds(us: number): void; read(): number; detach(): void; attached(): boolean; }
`;

let monacoP: Promise<typeof Monaco> | null = null;
function loadMonaco() {
  monacoP ??= (async () => {
    const [{ default: EditorWorker }, { default: TsWorker }] = await Promise.all([
      import('monaco-editor/editor/editor.worker?worker'),
      import('monaco-editor/language/typescript/ts.worker?worker'),
    ]);
    (self as any).MonacoEnvironment = {
      getWorker: (_: string, label: string) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()),
    };
    const m = await import('monaco-editor');
    const ts = (m as any).languages?.typescript ?? (m as any).typescript;
    ts?.javascriptDefaults?.addExtraLib(API_DTS, 'bench-api.d.ts');
    ts?.javascriptDefaults?.setCompilerOptions({ target: 99, allowNonTsExtensions: true, lib: ['es2022'] });
    return m;
  })();
  return monacoP;
}

export interface DockHooks {
  program(uid: string): Program | undefined;
  setProgram(uid: string, p: Program): void;
  boardName(uid: string): string;
  canLoadFirmware(uid: string): boolean;
  loadFirmware(uid: string): void;
  sendSerial(uid: string, text: string): void;
  /** put the program on a real board (arduino-cli) */
  realBoard?(uid: string): void;
}

const h = (tag: string, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) (e as any)[k] = v;
  e.append(...kids);
  return e;
};

export class Dock {
  el: HTMLElement;
  private title = h('span', { className: 'dock-title' });
  private lang = h('select', { title: 'Language' }) as HTMLSelectElement;
  private fwBtn = h('button', { textContent: 'Load firmware (.uf2)...', title: 'Run a real compiled RP2040 program instead of the code here' }) as HTMLButtonElement;
  private fwNote = h('span', { className: 'note' });
  private editorHost = h('div', { className: 'dock-editor' });
  private serialPre = h('pre', { className: 'dock-serial' });
  private serialIn = h('input', { type: 'text', placeholder: 'Send to the board (Enter)' }) as HTMLInputElement;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monaco: typeof Monaco | null = null;
  uid: string | null = null;
  private serial = new Map<string, string>();
  private saveTimer = 0;
  // the serial plotter: numbers printed one line at a time ("12, 40" or "speed:12 target:40"), graphed
  private plotOn = false;
  private plotBtn = h('button', { textContent: 'Plot', title: 'Graph the numbers the program prints (one line per reading: "12, 40" or "speed:12 target:40")' }) as HTMLButtonElement;
  private plotCanvas = h('canvas', { className: 'dock-plot', width: 420, height: 180 }) as HTMLCanvasElement;
  private plots = new Map<string, { partial: string; series: Map<string, number[]>; order: string[] }>();
  private plotPending = false;

  constructor(parent: HTMLElement, private hooks: DockHooks) {
    this.lang.append(h('option', { value: 'js', textContent: 'JavaScript' }), h('option', { value: 'arduino', textContent: 'Arduino C++ (simple sketches)' }));
    this.lang.onchange = () => this.changeLang();
    this.fwBtn.onclick = () => this.uid && hooks.loadFirmware(this.uid);
    this.serialIn.onkeydown = (e) => {
      if (e.key === 'Enter' && this.uid) {
        hooks.sendSerial(this.uid, this.serialIn.value + '\n');
        this.appendSerial(this.uid, `> ${this.serialIn.value}\n`);
        this.serialIn.value = '';
      }
    };
    this.el = h('div', { className: 'dock' },
      h('div', { className: 'dock-head' }, this.title, this.lang, this.fwBtn, this.fwNote, h('span', { className: 'spacer' }),
        h('button', { textContent: 'Upload to a real board...', title: 'Compile this program and upload it to a real board on USB (with arduino-cli, which comes with the Arduino IDE)', onclick: () => { if (this.uid) { this.flush(); hooks.realBoard?.(this.uid); } } }),
        h('button', { textContent: 'Clear serial', onclick: () => { if (this.uid) { this.serial.set(this.uid, ''); this.serialPre.textContent = ''; this.plots.delete(this.uid); this.drawPlot(); } } }),
        h('button', { textContent: 'Close', onclick: () => this.close() })),
      h('div', { className: 'dock-body' }, this.editorHost,
        h('div', { className: 'dock-side' }, h('div', { className: 'dock-label' }, h('span', { textContent: 'Serial monitor' }), this.plotBtn), this.plotCanvas, this.serialPre, this.serialIn)));
    this.plotCanvas.style.display = 'none';
    this.plotBtn.onclick = () => {
      this.plotOn = !this.plotOn;
      this.plotBtn.classList.toggle('active', this.plotOn);
      this.plotCanvas.style.display = this.plotOn ? '' : 'none';
      this.drawPlot();
    };
    this.el.style.display = 'none';
    parent.append(this.el);
  }

  get visible() {
    return this.el.style.display !== 'none';
  }

  async open(uid: string) {
    this.uid = uid;
    this.el.style.display = '';
    this.title.textContent = `Program: ${this.hooks.boardName(uid)}`;
    let prog = this.hooks.program(uid);
    if (!prog) {
      prog = { lang: 'js', source: DEFAULT_JS };
      this.hooks.setProgram(uid, prog);
    }
    this.lang.value = prog.lang;
    this.fwBtn.style.display = this.hooks.canLoadFirmware(uid) ? '' : 'none';
    this.fwNote.textContent = prog.firmware ? `runs ${prog.firmwareName ?? 'firmware'} (the code here is ignored)` : '';
    this.serialPre.textContent = this.serial.get(uid) ?? '';
    this.drawPlot();
    if (!this.monaco) {
      this.editorHost.textContent = 'Loading the editor...';
      this.monaco = await loadMonaco();
      this.editorHost.textContent = '';
      this.editor = this.monaco.editor.create(this.editorHost, {
        value: '', language: 'javascript', theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, tabSize: 2,
      });
      this.editor.onDidChangeModelContent(() => {
        clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => this.save(), 300);
      });
    }
    if (this.uid !== uid) return;
    const model = this.editor!.getModel()!;
    this.monaco.editor.setModelLanguage(model, prog.lang === 'arduino' ? 'cpp' : 'javascript');
    if (model.getValue() !== prog.source) model.setValue(prog.source);
    this.monaco.editor.setModelMarkers(model, 'bench', []);
  }

  private save() {
    if (!this.uid || !this.editor) return;
    const prev = this.hooks.program(this.uid);
    this.hooks.setProgram(this.uid, { ...(prev ?? { lang: 'js' }), lang: this.lang.value as Program['lang'], source: this.editor.getValue() });
  }
  private changeLang() {
    if (!this.uid || !this.editor || !this.monaco) return;
    const lang = this.lang.value as Program['lang'];
    const src = this.editor.getValue();
    const isDefault = src === DEFAULT_JS || src === DEFAULT_ARDUINO;
    this.monaco.editor.setModelLanguage(this.editor.getModel()!, lang === 'arduino' ? 'cpp' : 'javascript');
    if (isDefault) this.editor.setValue(lang === 'arduino' ? DEFAULT_ARDUINO : DEFAULT_JS);
    this.save();
  }

  close() {
    this.save();
    this.el.style.display = 'none';
  }

  /** Save what's typed now (before another project replaces this one). */
  flush() {
    clearTimeout(this.saveTimer);
    this.save();
  }
  /** Another project is open: show its program for the same board, or close if it has no such board.
   *  (Never write the old project's text into the new one.) */
  projectChanged() {
    clearTimeout(this.saveTimer);
    if (!this.visible || !this.uid || this.hooks.boardName(this.uid) === '?') {
      // (what the editor holds is the old project's: it must never be saved into this one)
      this.el.style.display = 'none';
      this.uid = null;
      return;
    }
    void this.open(this.uid);
  }

  /** an error from the running program: underline its line */
  markError(uid: string, line: number | null, message: string) {
    if (uid !== this.uid || !this.editor || !this.monaco || !line) return;
    const model = this.editor.getModel()!;
    if (line > model.getLineCount()) return;
    this.monaco.editor.setModelMarkers(model, 'bench', [{
      severity: this.monaco.MarkerSeverity.Error, message, startLineNumber: line, endLineNumber: line, startColumn: 1, endColumn: model.getLineMaxColumn(line),
    }]);
    this.editor.revealLineInCenter(line);
  }

  appendSerial(uid: string, text: string) {
    this.plotFeed(uid, text);
    let s = (this.serial.get(uid) ?? '') + text;
    if (s.length > 40000) s = s.slice(-30000);
    this.serial.set(uid, s);
    if (uid === this.uid) {
      const atBottom = this.serialPre.scrollTop + this.serialPre.clientHeight >= this.serialPre.scrollHeight - 30;
      this.serialPre.textContent = s;
      if (atBottom) this.serialPre.scrollTop = this.serialPre.scrollHeight;
    }
  }
  serialText(uid: string) {
    return this.serial.get(uid) ?? '';
  }
  clearAllSerial() {
    this.serial.clear();
    this.serialPre.textContent = '';
    this.plots.clear();
    this.drawPlot();
  }

  /** the serial plotter reads each whole line: numbers separated by commas, spaces or tabs, each
   *  optionally named ("temp:21.5"); unnamed ones are "1", "2"... (as the Arduino IDE's plotter) */
  private plotFeed(uid: string, text: string) {
    let p = this.plots.get(uid);
    if (!p) this.plots.set(uid, (p = { partial: '', series: new Map(), order: [] }));
    const lines = (p.partial + text).split('\n');
    p.partial = lines.pop() ?? '';
    if (p.partial.length > 2000) p.partial = '';
    let got = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('>') || line.startsWith('---') || line.startsWith('[')) continue;
      const items = line.split(/[,\t ]+/).filter(Boolean);
      let k = 0;
      const vals: [string, number][] = [];
      for (const it of items) {
        const m = /^([A-Za-z_][\w.]*)[:=](-?[\d.]+(?:e-?\d+)?)$/.exec(it);
        if (m) vals.push([m[1], Number(m[2])]);
        else if (/^-?[\d.]+(?:e-?\d+)?$/.test(it) && !Number.isNaN(Number(it))) vals.push([String(++k), Number(it)]);
      }
      if (!vals.length || vals.length < items.length / 2) continue; // (a sentence with a number in it isn't data)
      for (const [name, v] of vals) {
        let s = p.series.get(name);
        if (!s) {
          if (p.series.size >= 8) continue;
          p.series.set(name, (s = []));
          p.order.push(name);
        }
        s.push(v);
        if (s.length > 500) s.splice(0, s.length - 500);
      }
      got = true;
    }
    if (got && this.plotOn && uid === this.uid && !this.plotPending) {
      this.plotPending = true;
      requestAnimationFrame(() => { this.plotPending = false; this.drawPlot(); });
    }
  }
  /** what the plotter has (for tests): each series' name, count and last value */
  plotData(uid: string) {
    const p = this.plots.get(uid);
    return p ? p.order.map((n) => ({ name: n, count: p.series.get(n)!.length, last: p.series.get(n)!.at(-1) })) : [];
  }
  private drawPlot() {
    if (!this.plotOn) return;
    const cv = this.plotCanvas, g = cv.getContext('2d')!;
    const w = cv.width, hh = cv.height;
    g.fillStyle = '#12151a';
    g.fillRect(0, 0, w, hh);
    const p = this.uid ? this.plots.get(this.uid) : undefined;
    g.font = '11px sans-serif';
    if (!p || !p.order.length) {
      g.fillStyle = '#6b7280';
      g.fillText('Print numbers, one line per reading: Serial.println(value) or Serial.print("a:"); ...', 8, 20);
      return;
    }
    let lo = Infinity, hi = -Infinity;
    for (const s of p.series.values()) for (const v of s) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const yOf = (v: number) => hh - 16 - ((v - lo) / (hi - lo)) * (hh - 30);
    g.strokeStyle = '#232833';
    g.fillStyle = '#6b7280';
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4, y = yOf(v);
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      g.fillText(Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2), 2, y - 2);
    }
    const colors = ['#ffd25a', '#5ad1ff', '#ff7a7a', '#8cff8a', '#d59bff', '#ffa85a', '#5affc8', '#ff8ad8'];
    p.order.forEach((name, i) => {
      const s = p.series.get(name)!;
      g.strokeStyle = colors[i % colors.length];
      g.lineWidth = 1.5;
      g.beginPath();
      s.forEach((v, j) => {
        const x = w - (s.length - 1 - j) * (w / 500) - 2;
        if (j === 0) g.moveTo(x, yOf(v)); else g.lineTo(x, yOf(v));
      });
      g.stroke();
      g.fillStyle = colors[i % colors.length];
      g.fillText(`${name}: ${s.at(-1)}`, 50 + i * 90, 12);
    });
  }
  refreshFirmwareNote() {
    if (!this.uid) return;
    const prog = this.hooks.program(this.uid);
    this.fwNote.textContent = prog?.firmware ? `runs ${prog.firmwareName ?? 'firmware'} (the code here is ignored)` : '';
  }
}
