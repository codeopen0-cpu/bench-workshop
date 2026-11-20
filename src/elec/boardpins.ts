// What works on the bench but not on the real board: the pins each real chip treats specially.
// Part of the circuit check (check.ts): it reads the wiring and the board's program (the pin numbers
// it uses), never runs anything.
//   - ESP32: pins wired to its flash chip; input-only pins (34-39) used as outputs or with pull-ups;
//     boot pins (0, 12) a part could hold the wrong way at power-up; ADC2 pins read while Wi-Fi is on;
//     the USB serial's TX / RX.
//   - ESP32-S3 / C3, ESP8266: their own boot pins, ADC2, USB and flash pins.
//   - Any 3.3 V board: a 5 V part's signal straight into a pin (it needs a level shifter); a motor or
//     servo powered through the board; a module powered from a GPIO pin.
import type { PinDef } from '../parts/types';
import type { Project } from '../project';
import type { PartView } from '../views';

export interface PinAt { uid: string; pin: PinDef; view: PartView }
type Add = (level: 'fault' | 'warn', key: string, what: string, parts: string[]) => void;

/** Boards whose pins take 3.3 V (the others here are 5 V boards). */
const BOARD_3V3 = new Set(['esp32-board', 'esp32s3-board', 'esp32c3-mini', 'esp8266-nodemcu', 'esp8266-d1mini', 'pico-w', 'maker-board', 'rp2040-board']);

/** pin id -> GPIO number, for reading a program's pin numbers */
function gpioOf(type: string, id: string): number | null {
  if (type.startsWith('esp8266')) {
    const m: Record<string, number> = { D0: 16, D1: 5, D2: 4, D3: 0, D4: 2, D5: 14, D6: 12, D7: 13, D8: 15, RX: 3, TX: 1, A0: 17, SD2: 9, SD3: 10 };
    return m[id] ?? null;
  }
  if (type === 'esp32-board') {
    const m: Record<string, number> = { VP: 36, VN: 39, TX: 1, RX: 3, SD0: 7, SD1: 8, SD2: 9, SD3: 10, CMD: 11, CLK: 6 };
    if (id in m) return m[id];
  }
  if (type === 'esp32s3-board' && (id === 'TX' || id === 'RX')) return id === 'TX' ? 43 : 44;
  const io = /^(?:IO|GP|GPIO|D)(\d+)$/.exec(id);
  return io ? Number(io[1]) : null;
}

/** How a program uses its pins: by GPIO number (names from #define / const int resolved). */
interface PinUse { output: Set<number>; pullup: Set<number>; analogRead: Set<number>; pwm: Set<number>; interrupt: Set<number>; wifi: boolean; serial: boolean }
export function readPinUse(source: string, type: string): PinUse {
  const use: PinUse = { output: new Set(), pullup: new Set(), analogRead: new Set(), pwm: new Set(), interrupt: new Set(), wifi: false, serial: false };
  if (!source) return use;
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const names = new Map<string, number>();
  for (const m of code.matchAll(/#define\s+(\w+)\s+\(?\s*(\d+)\s*\)?/g)) names.set(m[1], Number(m[2]));
  for (const m of code.matchAll(/(?:const\s+)?(?:static\s+)?(?:int|uint8_t|byte|short|long|unsigned|gpio_num_t|constexpr\s+int)\s+(\w+)\s*=\s*(\d+)\s*[;,]/g)) names.set(m[1], Number(m[2]));
  // (an ESP8266 sketch names its pins D1, D2...; an ESP32's A0 is 36)
  const named: Record<string, number> = type.startsWith('esp8266') ? { D0: 16, D1: 5, D2: 4, D3: 0, D4: 2, D5: 14, D6: 12, D7: 13, D8: 15, A0: 17 } : type === 'esp32-board' ? { A0: 36, A3: 39, A4: 32, A5: 33, A6: 34, A7: 35 } : {};
  const num = (tok: string): number | null => {
    const t = tok.trim();
    if (/^\d+$/.test(t)) return Number(t);
    if (names.has(t)) return names.get(t)!;
    if (t in named) return named[t];
    const g = /^GPIO_NUM_(\d+)$/.exec(t);
    return g ? Number(g[1]) : null;
  };
  const each = (re: RegExp, f: (args: string[]) => void) => {
    for (const m of code.matchAll(re)) f(m.slice(1));
  };
  each(/pinMode\s*\(\s*([\w]+)\s*,\s*(\w+)\s*\)/g, ([p, mode]) => {
    const n = num(p);
    if (n === null) return;
    if (/OUTPUT/.test(mode)) use.output.add(n);
    if (/PULLUP|PULLDOWN/.test(mode)) use.pullup.add(n);
  });
  each(/digitalWrite\s*\(\s*([\w]+)\s*,/g, ([p]) => { const n = num(p); if (n !== null) use.output.add(n); });
  each(/analogWrite\s*\(\s*([\w]+)\s*,/g, ([p]) => { const n = num(p); if (n !== null) { use.output.add(n); use.pwm.add(n); } });
  each(/ledcAttach(?:Pin)?\s*\(\s*([\w]+)\s*,/g, ([p]) => { const n = num(p); if (n !== null) { use.output.add(n); use.pwm.add(n); } });
  each(/\.attach\s*\(\s*([\w]+)\s*[,)]/g, ([p]) => { const n = num(p); if (n !== null) { use.output.add(n); use.pwm.add(n); } });
  each(/analogRead\s*\(\s*([\w]+)\s*\)/g, ([p]) => { const n = num(p); if (n !== null) use.analogRead.add(n); });
  each(/attachInterrupt\s*\(\s*(?:digitalPinToInterrupt\s*\(\s*)?([\w]+)/g, ([p]) => { const n = num(p); if (n !== null) use.interrupt.add(n); });
  use.wifi = /\bWiFi\s*\.\s*(begin|softAP|mode)\b|esp_now_init|BluetoothSerial|BLEDevice/.test(code);
  use.serial = /\bSerial\s*\.\s*(begin|print|println|printf|write|read|available)\b/.test(code);
  return use;
}

export function boardPinIssues(
  project: Project,
  views: Map<string, PartView>,
  netOf: (uid: string, pin: string) => PinAt[],
  sourceVolts: (v: PartView, pin: PinDef) => number | null,
  programmable: Set<string>,
  isPowerPart: (v: PartView) => boolean,
  add: Add,
) {
  const label = (p: PinAt) => `${p.view.inst.name} ${p.pin.label ?? p.pin.id}`;
  /** the highest supply on a net (null: none) */
  const topVolts = (net: PinAt[]) => {
    const vs = net.map((p) => sourceVolts(p.view, p.pin)).filter((x): x is number => x !== null);
    // (a board on USB gives 5 V on its 5V / VBUS pin)
    for (const p of net)
      if (p.pin.kind === 'vin' && programmable.has(p.view.inst.type) && p.view.inst.params.usb === true && /5V|VBUS/i.test(`${p.pin.id} ${p.pin.label ?? ''}`)) vs.push(5);
    return vs.length ? Math.max(...vs) : null;
  };
  /** what a part runs on: its supply pins' highest voltage */
  const partVolts = (v: PartView) => {
    let top: number | null = null;
    for (const p of v.build.pins ?? [])
      if (p.kind === 'vin') {
        const t = topVolts(netOf(v.inst.uid, p.id).filter((q) => q.uid !== v.inst.uid));
        if (t !== null) top = Math.max(top ?? 0, t);
      }
    return top;
  };
  const others = (uid: string, pin: string) => netOf(uid, pin).filter((q) => q.uid !== uid);

  for (const v of views.values()) {
    const type = v.inst.type;
    if (!programmable.has(type)) continue;
    const uid = v.inst.uid;
    const prog = project.programs[uid];
    const src = prog && prog.lang === 'arduino' ? [prog.source ?? '', ...Object.values(((prog as any).files ?? {}) as Record<string, string>)].join('\n') : '';
    const use = readPinUse(src, type);
    const pins = (v.build.pins ?? []).filter((p) => p.kind === 'io' || p.kind === 'i2c' || p.kind === 'in' || p.kind === 'out');
    const pinByGpio = new Map<number, PinDef>();
    for (const p of pins) {
      const g = gpioOf(type, p.id);
      if (g !== null) pinByGpio.set(g, p);
    }
    const nameOf = (g: number) => pinByGpio.get(g)?.label ?? pinByGpio.get(g)?.id ?? `pin ${g}`;
    const wiredGpio = (g: number) => {
      const p = pinByGpio.get(g);
      return p ? others(uid, p.id) : [];
    };
    const onlyButtons = (net: PinAt[]) => net.length > 0 && net.every((q) => q.view.inst.type === 'button' || q.pin.kind === 'gnd');
    const B = v.inst.name;

    // ---- the classic ESP32
    if (type === 'esp32-board') {
      for (const id of ['SD0', 'SD1', 'SD2', 'SD3', 'CMD', 'CLK'])
        if (others(uid, id).length)
          add('fault', `flash:${uid}/${id}`, `${B} ${id}: this pin is wired to the board's own flash memory (GPIO 6-11), where its program lives. Anything on it crashes a real ESP32. Use another pin.`, [uid]);
      for (const g of [34, 35, 36, 37, 38, 39]) {
        const net = wiredGpio(g);
        const drives = use.output.has(g) || net.some((q) => q.pin.kind === 'in' && !programmable.has(q.view.inst.type) && !net.some((o) => o.pin.kind === 'out' && o.uid !== uid));
        if (drives && (net.length || use.output.has(g)))
          add('fault', `inonly:${uid}/${g}`, `${B} ${nameOf(g)} is input only on a real ESP32 (GPIO 34-39 can't drive anything): ${use.output.has(g) ? 'the program uses it as an output' : `it is wired to ${net.filter((q) => q.pin.kind === 'in').map(label).join(', ')}, which needs driving`}. Use a pin like 25, 26, 27, 32 or 33.`, [uid, ...net.map((q) => q.uid)]);
        if (use.pullup.has(g))
          add('warn', `nopull:${uid}/${g}`, `${B} ${nameOf(g)}: GPIO 34-39 have no pull-up or pull-down inside the chip, so INPUT_PULLUP does nothing on a real ESP32 and the pin floats. Add a 10k resistor to 3.3 V (or GND), or use another pin.`, [uid]);
      }
      const io0 = wiredGpio(0);
      if (io0.length && !onlyButtons(io0))
        add('warn', `boot0:${uid}`, `${B} IO0 is a boot pin: if anything holds it LOW while the ESP32 powers up, it waits for an upload instead of running the program. ${io0.map(label).join(', ')} is on it: make sure that stays HIGH (or loose) at power-up, or use another pin. (A button to GND is fine: that's what the BOOT button does.)`, [uid, ...io0.map((q) => q.uid)]);
      const io12 = wiredGpio(12);
      if (io12.length && io12.some((q) => q.pin.kind === 'out' || q.pin.kind === 'vout' || q.pin.pulled === 'up' || sourceVolts(q.view, q.pin) !== null))
        add('warn', `boot12:${uid}`, `${B} IO12 sets the flash memory's voltage at power-up: if ${io12.map(label).join(', ')} pulls it HIGH then, a real ESP32 won't start (it resets over and over). Use another pin for that, or make sure it's LOW at power-up.`, [uid, ...io12.map((q) => q.uid)]);
      const io2 = wiredGpio(2);
      if (io2.length && io2.some((q) => q.pin.kind === 'out' || q.pin.pulled === 'up'))
        add('warn', `boot2:${uid}`, `${B} IO2 must be LOW or loose for uploads to work: ${io2.map(label).join(', ')} may hold it HIGH, and uploading then fails ("Timed out waiting for packet header"). Unplug it to upload, or use another pin.`, [uid, ...io2.map((q) => q.uid)]);
      if (use.wifi)
        for (const g of [0, 2, 4, 12, 13, 14, 15, 25, 26, 27])
          if (use.analogRead.has(g))
            add('fault', `adc2:${uid}/${g}`, `${B} reads ${nameOf(g)} with analogRead while it uses Wi-Fi: that pin is on ADC2, which Wi-Fi takes over on a real ESP32 (analogRead fails or gives nonsense). Use an ADC1 pin: 32, 33, 34, 35, 36 (VP) or 39 (VN).`, [uid]);
      for (const id of ['TX', 'RX'])
        if (others(uid, id).length && use.serial)
          add('warn', `uart0:${uid}/${id}`, `${B} ${id} is also the USB serial (Serial): what the program prints goes out on it too, and ${id === 'RX' ? 'a part driving RX can stop uploads and garble what you send' : 'the part on it gets everything printed'}. Use Serial2 on other pins (e.g. 16 / 17) for that part.`, [uid]);
    }

    // ---- ESP32-S3
    if (type === 'esp32s3-board') {
      for (const g of [35, 36, 37]) {
        if (wiredGpio(g).length)
          add('warn', `psram:${uid}/${g}`, `${B} IO${g}: on S3 modules with 8 MB of PSRAM (N8R8, N16R8) GPIO 35-37 belong to the PSRAM: a part on it crashes the board. Fine on modules without PSRAM; safest to use another pin.`, [uid]);
      }
      for (const g of [45, 46]) {
        const net = wiredGpio(g);
        if (net.some((q) => q.pin.kind === 'out' || q.pin.pulled === 'up' || q.pin.kind === 'vout'))
          add('warn', `strap:${uid}/${g}`, `${B} IO${g} is a boot pin (${g === 45 ? 'the flash voltage' : 'the boot mode'}): ${net.map(label).join(', ')} may pull it HIGH at power-up, and a real ESP32-S3 then doesn't start. Use another pin.`, [uid]);
      }
      const io0 = wiredGpio(0);
      if (io0.length && !onlyButtons(io0)) add('warn', `boot0:${uid}`, `${B} IO0 is the BOOT pin: held LOW at power-up, the S3 waits for an upload instead of running. Make sure ${io0.map(label).join(', ')} leaves it HIGH then.`, [uid]);
      for (const g of [19, 20])
        if (wiredGpio(g).length) add('warn', `usb:${uid}/${g}`, `${B} IO${g} is the S3's native USB (${g === 19 ? 'D-' : 'D+'}): a part on it cuts off the USB port (no uploads, no Serial over USB). Use another pin.`, [uid]);
      if (use.wifi)
        for (let g = 11; g <= 20; g++)
          if (use.analogRead.has(g)) add('fault', `adc2:${uid}/${g}`, `${B} reads IO${g} with analogRead while it uses Wi-Fi: that pin is on ADC2, which Wi-Fi takes over (analogRead fails). Use an ADC1 pin: IO1-IO10.`, [uid]);
    }

    // ---- ESP32-C3 SuperMini
    if (type === 'esp32c3-mini') {
      for (const g of [2, 8, 9]) {
        const net = wiredGpio(g);
        if (!net.length || (g === 9 && onlyButtons(net))) continue;
        if (net.some((q) => q.pin.kind === 'out' || (g !== 2 && q.pin.pulled === 'down') || q.pin.kind === 'gnd'))
          add('warn', `strap:${uid}/${g}`, `${B} IO${g} is a boot pin (it must be ${g === 2 ? 'HIGH or loose' : 'HIGH'} at power-up): ${net.map(label).join(', ')} may hold it the wrong way and a real C3 then waits for an upload or won't start. Use another pin, or make sure it's right at power-up.`, [uid]);
      }
      if (use.wifi && use.analogRead.has(5))
        add('fault', `adc2:${uid}/5`, `${B} reads IO5 with analogRead while it uses Wi-Fi: on the C3 that's ADC2, which doesn't work with Wi-Fi on. Use IO0-IO4.`, [uid]);
    }

    // ---- ESP8266
    if (type.startsWith('esp8266')) {
      for (const [id, g, want] of [['D3', 0, 'HIGH'], ['D4', 2, 'HIGH'], ['D8', 15, 'LOW']] as const) {
        const net = others(uid, id);
        if (!net.length) continue;
        const wrong = want === 'HIGH' ? net.some((q) => q.pin.kind === 'out' || q.pin.pulled === 'down' || (q.view.inst.type !== 'button' && q.pin.kind === 'gnd')) : net.some((q) => q.pin.kind === 'out' || q.pin.pulled === 'up' || q.pin.kind === 'vout');
        if (wrong) add('warn', `strap:${uid}/${id}`, `${B} ${id} (GPIO${g}) must be ${want} at power-up or a real ESP8266 won't start its program: ${net.map(label).join(', ')} may hold it ${want === 'HIGH' ? 'LOW' : 'HIGH'}. Use D1, D2, D5, D6 or D7 for that.`, [uid, ...net.map((q) => q.uid)]);
      }
      if (use.pwm.has(16) || use.interrupt.has(16))
        add('warn', `d0:${uid}`, `${B} D0 (GPIO16) can't do ${use.pwm.has(16) ? 'PWM (analogWrite, servos)' : 'interrupts'} on a real ESP8266. Use D1-D7.`, [uid]);
      for (const id of ['SD2', 'SD3'])
        if (others(uid, id).length) add(id === 'SD2' ? 'fault' : 'warn', `flash:${uid}/${id}`, `${B} ${id} (GPIO${id === 'SD2' ? 9 : 10}) is wired to the flash memory: ${id === 'SD2' ? 'using it crashes a real board' : 'it only works if the board is set to DIO flash mode'}. Use another pin.`, [uid]);
    }

    // ---- any 3.3 V board
    if (BOARD_3V3.has(type)) {
      for (const p of pins) {
        const net = others(uid, p.id);
        for (const q of net) {
          if (programmable.has(q.view.inst.type) || isPowerPart(q.view)) continue;
          if (!(q.pin.kind === 'out' || q.pin.kind === 'io' || q.pin.kind === 'i2c')) continue;
          const pv = partVolts(q.view);
          if (pv === null || pv < 4.5) continue;
          // (only parts made for 5 V alone: their outputs swing to it. Parts that take 3.3-5 V mostly
          //  have a regulator and 3.3 V logic inside, like an HC-05 or an SD card module)
          const vins = (q.view.build.pins ?? []).filter((x) => x.kind === 'vin');
          if (!vins.length || !vins.every((x) => (x.vmin ?? 0) >= 4 && (x.vmax ?? 99) <= 6)) continue;
          add('warn', `level:${uid}/${p.id}:${q.uid}`, `${label(q)} runs on ${pv.toFixed(1)} V, so its signal swings to ${pv.toFixed(1)} V, straight into ${B} ${p.label ?? p.id}, a 3.3 V pin. It works here; on the real board it strains the pin and can kill it in time. Put a level shifter between them (or a divider: 1k in series, 2k to GND), or run ${q.view.inst.name} on 3.3 V if it can.`, [uid, q.uid]);
        }
      }
    }

    // ---- any board: motors and servos powered through it; modules powered from a GPIO
    for (const p of v.build.pins ?? []) {
      const net = others(uid, p.id);
      if (p.kind === 'vout' || p.kind === 'vin') {
        const fedByPower = netOf(uid, p.id).some((q) => isPowerPart(q.view));
        for (const q of net) {
          if (q.pin.kind !== 'vin' || fedByPower) continue;
          // (something that moves real weight and takes its power on this pin: a servo, a smart
          //  servo; not a knob or an encoder, nor a motor whose power comes through a driver)
          const hasMotorPins = (q.view.build.pins ?? []).some((x) => x.kind === 'motor');
          // (a part with a logic supply and a motor supply: only the motor one counts)
          const topVin = Math.max(...(q.view.build.pins ?? []).filter((x) => x.kind === 'vin').map((x) => x.vmax ?? 0));
          if ((q.pin.vmax ?? 0) < topVin) continue;
          const moves = !hasMotorPins && ((q.view.build.joints ?? []).some((j) => j.actuator && j.actuator.kind !== 'free' && j.actuator.maxTorque >= 1) || !!q.view.build.thruster);
          if (moves)
            add('warn', `motorpower:${uid}/${p.id}:${q.uid}`, `${q.view.inst.name} takes its power through ${B}'s ${p.label ?? p.id} pin. A real one draws up to an amp or more when it starts or strains: the board's voltage dips and it resets (or its regulator overheats). Power ${q.view.inst.name} from a battery or a 5-6 V supply, with its GND joined to the board's.`, [uid, q.uid]);
        }
      }
      if (p.kind === 'io' && net.some((q) => q.pin.kind === 'vin' && !programmable.has(q.view.inst.type)))
        add('warn', `gpiopower:${uid}/${p.id}`, `${net.filter((q) => q.pin.kind === 'vin').map(label).join(', ')} gets its power from ${B} ${p.label ?? p.id}, a GPIO pin: those give 12-20 mA at most (40 mA kills them). Fine for a small sensor; anything more needs a 3.3 V / 5 V pin, or a transistor.`, [uid]);
    }
  }
}
