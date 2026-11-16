// Learn: short lessons on wiring and programming, done on the bench itself. Each step says what to do
// and ticks itself off when it's done (it watches the bench), and each lesson ends with what is
// different on a real bench, so what you learn here carries over to real parts.
import type { Project } from '../project';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'string') e.setAttribute('style', v);
    else (e as any)[k] = v;
  }
  e.append(...kids);
  return e;
};

/** what the lessons need from the app */
export interface TutorialHost {
  project(): Project;
  mode(): 'build' | 'run' | 'paused';
  /** status lines of a part while running (empty when not running) */
  status(uid: string): string[];
  newBench(): void;
  setProgram(uid: string, source: string): void;
  openProgram(uid: string): void;
  checkOpened(): boolean;
}

interface Step {
  say: string; // what to do (a little HTML: <b>, <code>)
  done(t: Tools): boolean;
  code?: { board: string; source: string }; // an "Insert this code" button for the board of that type
}
interface Lesson { title: string; intro: string; steps: Step[]; real: string }

class Tools {
  constructor(private h: TutorialHost) {}
  parts(type: string) { return this.h.project().parts.filter((p) => p.type === type); }
  has(type: string, n = 1) { return this.parts(type).length >= n; }
  /** a wire from (type, pin) to (type, pin), either way round */
  wired(t1: string, p1: string, t2: string, p2: string) {
    const ty = (uid: string) => this.h.project().parts.find((p) => p.uid === uid)?.type;
    return this.h.project().wires.some((w) =>
      (ty(w.a.uid) === t1 && w.a.pin === p1 && ty(w.b.uid) === t2 && w.b.pin === p2) || (ty(w.b.uid) === t1 && w.b.pin === p1 && ty(w.a.uid) === t2 && w.a.pin === p2));
  }
  running() { return this.h.mode() !== 'build'; }
  status(type: string) { return this.parts(type).flatMap((p) => this.h.status(p.uid)).join(' '); }
  program(type: string) { return this.parts(type).map((p) => this.h.project().programs[p.uid]?.source ?? '').join('\n'); }
  checked() { return this.h.checkOpened(); }
}

const BLINK = `// Blink: the LED on GP15 on for half a second, off for half a second.
void setup() {
  pinMode(15, OUTPUT);          // GP15 drives the LED
}

void loop() {
  digitalWrite(15, HIGH);       // 3.3 V on GP15: the LED lights
  delay(500);
  digitalWrite(15, LOW);        // 0 V: off
  delay(500);
}
`;
const MOTOR = `// Spin a motor through the DRV8833: forwards, stop, backwards, stop.
// AIN1 = GP2, AIN2 = GP3. One HIGH and one LOW turns it; both LOW stops it.
void setup() {
  pinMode(2, OUTPUT);
  pinMode(3, OUTPUT);
}

void loop() {
  digitalWrite(2, HIGH); digitalWrite(3, LOW);   // forwards
  delay(2000);
  digitalWrite(2, LOW);  digitalWrite(3, LOW);   // stop
  delay(1000);
  digitalWrite(2, LOW);  digitalWrite(3, HIGH);  // backwards
  delay(2000);
  digitalWrite(2, LOW);  digitalWrite(3, LOW);   // stop
  delay(1000);
}
`;
const SENSOR = `// Read the motion sensor (MPU-6050) over I2C and print how much gravity it feels, up and down.
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.beginTransmission(0x68);   // the sensor's I2C address
  Wire.write(0x6B);               // register PWR_MGMT_1...
  Wire.write(0);                  // ...= 0: wake up (it starts asleep)
  Wire.endTransmission();
}

void loop() {
  Wire.beginTransmission(0x68);
  Wire.write(0x3F);               // start at ACCEL_ZOUT_H (the up/down reading)
  Wire.endTransmission();
  Wire.requestFrom(0x68, 2);      // read 2 bytes: high, low
  int z = (Wire.read() << 8) | Wire.read();
  if (z > 32767) z -= 65536;      // it's a signed number
  Serial.print("Up/down: ");
  Serial.print(z / 16384.0);      // 16384 = 1 g
  Serial.println(" g");
  delay(500);
}
`;

export const LESSONS: Lesson[] = [
  {
    title: '1. Light an LED',
    intro: 'The simplest circuit: a battery, an LED, two wires. Current flows out of the battery\'s +, through the LED, and back into its -.',
    steps: [
      { say: 'From the parts list (left, <b>Power</b>), click <b>AA battery pack</b>, then click on the bench to put it down.', done: (t) => t.has('battery-4aa') },
      { say: 'From <b>Electronics</b>, put an <b>LED</b> next to it.', done: (t) => t.has('led') },
      { say: 'Press <b>Wire</b> (or <code>C</code>). Click the battery\'s red <b>+</b> pin, then the LED\'s <b>A</b> pin (the long leg).', done: (t) => t.wired('battery-4aa', '+', 'led', 'A') },
      { say: 'Now the battery\'s black <b>-</b> pin to the LED\'s <b>K</b> pin. That closes the loop.', done: (t) => t.wired('battery-4aa', '-', 'led', 'K') },
      { say: 'Press <b>Run</b>. The LED lights; the panel on the right says how bright.', done: (t) => t.running() && /lit/.test(t.status('led')) },
    ],
    real: 'An LED only works one way round: the long leg (A, anode) towards +. Backwards it just stays dark. A real LED also needs a resistor in series (220-470 ohm from 5-6 V), or it burns out at once: the one here has it built in. Wire with the battery disconnected, connect it last.',
  },
  {
    title: '2. Add a switch',
    intro: 'A push button connects its two pins while it\'s pressed. Put it in the loop and it decides whether current can flow.',
    steps: [
      { say: 'Start from lesson 1 (battery, LED, two wires), or press <b>Start on a fresh bench</b> and build it again.', done: (t) => t.has('battery-4aa') && t.has('led') },
      { say: 'Put a <b>Push button</b> down (<b>Electronics</b>).', done: (t) => t.has('button') },
      { say: 'Wire it into the loop: the LED\'s <b>A</b> should go through the button. Wire battery <b>+</b> to button pin <b>1</b>, and button pin <b>2</b> to LED <b>A</b>. (Select the old wire from + to A and delete it with <code>Del</code>.)', done: (t) => t.wired('battery-4aa', '+', 'button', '1') && t.wired('button', '2', 'led', 'A') && !t.wired('battery-4aa', '+', 'led', 'A') },
      { say: 'Press <b>Run</b>, then click the button on the bench and hold it: the LED lights while you hold it.', done: (t) => t.running() && /lit/.test(t.status('led')) },
    ],
    real: 'Real buttons often have 4 legs: they come in pairs that are always joined, and pressing joins the pairs. Check with a multimeter (continuity beep) which legs are which before soldering.',
  },
  {
    title: '3. Program a board',
    intro: 'A microcontroller board turns pins on and off from a program. Here: blink an LED. The same code runs on a real board.',
    steps: [
      { say: 'Press <b>Start on a fresh bench</b>, then put down a <b>Maker board (programmable)</b> (<b>Boards</b>). It is powered by its USB cable (see the right panel).', done: (t) => t.has('maker-board') },
      { say: 'Put an <b>LED</b> next to it.', done: (t) => t.has('led') },
      { say: 'Wire the board\'s <b>GP15</b> to the LED\'s <b>A</b>, and the board\'s <b>GND</b> to the LED\'s <b>K</b>.', done: (t) => t.wired('maker-board', 'GP15', 'led', 'A') && (t.wired('maker-board', 'GND', 'led', 'K') || t.wired('maker-board', 'GND2', 'led', 'K')) },
      { say: 'Give the board its program: press <b>Insert this code</b> (it opens in the editor at the bottom: read the comments).', done: (t) => /digitalWrite\s*\(\s*15/.test(t.program('maker-board')), code: { board: 'maker-board', source: BLINK } },
      { say: 'Press <b>Run</b>. The LED blinks. Try changing <code>delay(500)</code> to <code>delay(100)</code>, Stop and Run again.', done: (t) => t.running() && /running/.test(t.status('maker-board')) },
    ],
    real: 'On a real board you upload this exact sketch with the Arduino IDE (or PlatformIO). Pins are named by their GPIO number on the board\'s silkscreen. A pin gives 3.3 V and only about 20 mA: enough for an LED with its resistor, not for a motor (next lesson).',
  },
  {
    title: '4. Drive a motor',
    intro: 'Motors need far more current than a pin can give. A motor driver (DRV8833) takes the board\'s small signals and switches the battery\'s power to the motor.',
    steps: [
      { say: 'Fresh bench. Put down a <b>Maker board</b>, a <b>Motor driver (DRV8833)</b> (<b>Electronics</b>), a <b>Gear motor</b> (<b>Motion</b>) and an <b>AA battery pack</b>.', done: (t) => t.has('maker-board') && t.has('drv8833') && t.has('motor-tt') && t.has('battery-4aa') },
      { say: 'Motor power: battery <b>+</b> to the driver\'s <b>VM</b>, battery <b>-</b> to the driver\'s <b>GND</b>.', done: (t) => t.wired('battery-4aa', '+', 'drv8833', 'VM') && t.wired('battery-4aa', '-', 'drv8833', 'GND') },
      { say: 'Shared ground (important!): the board\'s <b>GND</b> to the driver\'s <b>GND</b>. Without it, the driver can\'t tell what the board\'s signals mean.', done: (t) => t.wired('maker-board', 'GND', 'drv8833', 'GND') || t.wired('maker-board', 'GND2', 'drv8833', 'GND') },
      { say: 'Signals: board <b>GP2</b> to driver <b>AIN1</b>, board <b>GP3</b> to driver <b>AIN2</b>.', done: (t) => t.wired('maker-board', 'GP2', 'drv8833', 'AIN1') && t.wired('maker-board', 'GP3', 'drv8833', 'AIN2') },
      { say: 'Motor: driver <b>AOUT1</b> to the motor\'s <b>M+</b>, driver <b>AOUT2</b> to the motor\'s <b>M-</b>.', done: (t) => t.wired('drv8833', 'AOUT1', 'motor-tt', 'M+') && t.wired('drv8833', 'AOUT2', 'motor-tt', 'M-') },
      { say: 'Insert the program, then <b>Run</b>: forwards, stop, backwards, stop.', done: (t) => t.running() && /running/.test(t.status('maker-board')) && /digitalWrite\s*\(\s*2/.test(t.program('maker-board')), code: { board: 'maker-board', source: MOTOR } },
    ],
    real: 'Never power a motor from a board\'s pin or its 3.3 V: use a driver and a separate supply for the motor, with the grounds joined. Swapping the motor\'s two wires reverses it. Motors make electrical noise: a 100 nF capacitor across the motor\'s terminals helps real boards stay stable.',
  },
  {
    title: '5. Read a sensor (I2C)',
    intro: 'Many sensors talk over I2C: two signal wires (SDA = data, SCL = clock) shared by every sensor, each at its own address.',
    steps: [
      { say: 'Fresh bench. Put down a <b>Maker board</b> and a <b>Motion sensor (MPU-6050)</b> (<b>Sensors</b>).', done: (t) => t.has('maker-board') && t.has('mpu6050') },
      { say: 'Power: board <b>3V3</b> to sensor <b>VCC</b>, board <b>GND</b> to sensor <b>GND</b>.', done: (t) => t.wired('maker-board', '3V3', 'mpu6050', 'VCC') && (t.wired('maker-board', 'GND', 'mpu6050', 'GND') || t.wired('maker-board', 'GND2', 'mpu6050', 'GND')) },
      { say: 'The bus: board <b>SDA</b> to sensor <b>SDA</b>, board <b>SCL</b> to sensor <b>SCL</b>. (SDA to SCL is the classic mistake: Check catches it.)', done: (t) => t.wired('maker-board', 'SDA', 'mpu6050', 'SDA') && t.wired('maker-board', 'SCL', 'mpu6050', 'SCL') },
      { say: 'Insert the program and <b>Run</b>. Press <b>Serial / program</b> on the board in the right panel to see what it prints (about 1 g: gravity). Drag the sensor around while it runs.', done: (t) => t.running() && /running/.test(t.status('maker-board')) && /0x68/.test(t.program('maker-board')), code: { board: 'maker-board', source: SENSOR } },
    ],
    real: 'Real I2C needs pull-up resistors on SDA and SCL (most sensor boards have them). Use short wires, and check the sensor\'s voltage: many take 3.3 V only. If nothing answers, run an I2C scanner sketch: the address may differ (0x68 or 0x69 here).',
  },
  {
    title: '6. Check before you build',
    intro: 'Mistakes that destroy real parts (a short, a battery wired backwards, 9 V into a 5 V module) are easy to make. Check finds them before you build.',
    steps: [
      { say: 'On any bench, press <b>Check</b> in the toolbar. <b>Broken</b> = it would fail or damage something; <b>Check</b> = it looks wrong but may be meant.', done: (t) => t.checked() },
      { say: 'Try a mistake: wire a battery\'s <b>+</b> straight to its own <b>-</b>, then press <b>Check</b>. It says "Short circuit".', done: (t) => t.wired('battery-4aa', '+', 'battery-4aa', '-') || t.wired('battery-9v', '+', 'battery-9v', '-') },
      { say: 'Delete that wire and press <b>Check again</b>: it moves to <b>Fixed</b>. Pressing Run also checks first and warns about anything broken.', done: (t) => !t.wired('battery-4aa', '+', 'battery-4aa', '-') && !t.wired('battery-9v', '+', 'battery-9v', '-') },
    ],
    real: 'On a real bench: wire with the power off, check polarity before connecting a battery, power up with a current-limited bench supply first (the Bench power supply part shows what that does), and keep a finger near the switch the first time.',
  },
];

export class Tutorial {
  private panel: HTMLElement | null = null;
  private lesson = 0;
  private timer = 0;
  private t: Tools;
  private doneSteps = new Set<string>();
  constructor(private host: TutorialHost) {
    this.t = new Tools(host);
  }

  open(lesson = this.lesson) {
    this.lesson = lesson;
    if (!this.panel) {
      this.panel = el('div', { className: 'tut-panel' });
      document.body.append(this.panel);
      this.timer = window.setInterval(() => this.render(), 600);
    }
    this.render();
  }
  close() {
    clearInterval(this.timer);
    this.panel?.remove();
    this.panel = null;
  }

  private render() {
    if (!this.panel) return;
    const L = LESSONS[this.lesson];
    // steps are done in order, and stay done (stopping the run doesn't undo "press Run")
    let current = 0;
    while (current < L.steps.length && (this.doneSteps.has(`${this.lesson}:${current}`) || this.safe(L.steps[current]))) {
      this.doneSteps.add(`${this.lesson}:${current}`);
      current++;
    }
    const sig = `${this.lesson}:${current}`;
    if (this.panel.dataset.sig === sig) return;
    this.panel.dataset.sig = sig;
    const pick = el('select', { className: 'pm-input', onchange: (e: Event) => this.open(Number((e.target as HTMLSelectElement).value)) },
      ...LESSONS.map((l, i) => el('option', { value: String(i), textContent: l.title, selected: i === this.lesson }))) as HTMLSelectElement;
    const steps = L.steps.map((s, i) => {
      const state = i < current ? 'done' : i === current ? 'now' : 'later';
      const li = el('li', { className: `tut-step tut-${state}` });
      li.innerHTML = s.say; // (the lessons' own text, written above: no outside content)
      if (s.code && state === 'now') {
        const btn = el('button', { className: 'primary', textContent: 'Insert this code', onclick: () => {
          const board = this.host.project().parts.find((p) => p.type === s.code!.board);
          if (!board) return alert('Put the board on the bench first.');
          this.host.setProgram(board.uid, s.code!.source);
          this.host.openProgram(board.uid);
        } });
        li.append(el('div', { style: 'margin-top:6px' }, btn));
      }
      return li;
    });
    const done = current >= L.steps.length;
    this.panel.replaceChildren(
      el('div', { className: 'tut-head' }, el('b', { textContent: 'Learn' }), pick, el('span', { style: 'flex:1' }), el('button', { textContent: '×', title: 'Close', onclick: () => this.close() })),
      el('div', { className: 'tut-intro', textContent: L.intro }),
      el('ol', { className: 'tut-steps' }, ...steps),
      ...(done ? [el('div', { className: 'tut-done', textContent: 'Done! ' }, ...(this.lesson < LESSONS.length - 1 ? [el('button', { className: 'primary', textContent: 'Next lesson', onclick: () => this.open(this.lesson + 1) })] : []))] : []),
      el('div', { className: 'tut-real' }, el('b', { textContent: 'On a real bench: ' }), L.real),
      el('div', { className: 'tut-foot' }, el('button', { textContent: 'Start on a fresh bench', title: 'Clear the bench for this lesson (Undo brings the old one back)', onclick: () => {
        this.host.newBench();
        for (const k of [...this.doneSteps]) if (k.startsWith(`${this.lesson}:`)) this.doneSteps.delete(k);
        this.panel!.dataset.sig = '';
        this.render();
      } })),
    );
    console.info(`[learn] ${L.title}: step ${Math.min(current + 1, L.steps.length)} of ${L.steps.length}${done ? ' (done)' : ''}`);
  }
  private safe(s: Step) {
    try { return s.done(this.t); } catch { return false; }
  }
}
