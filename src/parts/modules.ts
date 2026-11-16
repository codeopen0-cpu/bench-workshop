// Breakout modules (common I2C chips on small boards) and the RP2040 board: their shapes and pins.
// What they do is in elec/modules.ts.
import { boxMesh, group, headerRow } from './geo';
import type { ParamDef, PartType, PinDef } from './types';

const P = 0.254; // 0.1 inch pitch, cm
const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
const addrParam = (addrs: number[], label = 'I2C address'): ParamDef => ({ key: 'addr', label, kind: 'select', options: addrs.map((a) => ({ value: String(a), label: hex(a) })) });

function row(ids: string[], y: number, z: number, kinds: Record<string, PinDef['kind']>, extra: Record<string, Partial<PinDef>> = {}): PinDef[] {
  const x0 = -((ids.length - 1) * P) / 2;
  return ids.map((id, i) => ({ id, body: 'body', pos: [x0 + i * P, y, z], kind: kinds[id] ?? 'io', ...(extra[id] ?? {}) }));
}
const BUS: Record<string, PinDef['kind']> = { VCC: 'vin', GND: 'gnd', SCL: 'i2c', SDA: 'i2c' };
const VCC: Record<string, Partial<PinDef>> = { VCC: { label: 'VCC (3.3-5 V)', vmin: 2.7, vmax: 5.5 } };

/** A flat breakout: a coloured board, a chip in the middle, a header row on one or both long edges. */
function breakout(o: {
  id: string; name: string; category?: string; description: string; color: string; w: number; d: number; mass: number;
  front: string[]; back?: string[]; kinds?: Record<string, PinDef['kind']>; extra?: Record<string, Partial<PinDef>>;
  addrs: number[]; params?: ParamDef[]; defaults?: Record<string, any>;
}): PartType {
  return {
    id: o.id,
    name: o.name,
    category: o.category ?? 'Modules',
    description: o.description,
    swatch: o.color,
    params: [addrParam(o.addrs), ...(o.params ?? [])],
    defaults: { addr: String(o.addrs[0]), ...(o.defaults ?? {}) },
    build: () => {
      const kinds = { ...BUS, ...(o.kinds ?? {}) }, extra = { ...VCC, ...(o.extra ?? {}) };
      const zf = o.d / 2 - 0.15, zb = -o.d / 2 + 0.15;
      return {
        bodies: [{
          name: 'body', pos: [0, 0.08, 0], mass: o.mass,
          colliders: [{ shape: { kind: 'box', hx: o.w / 2, hy: 0.08, hz: o.d / 2 } }],
          visual: group(
            boxMesh(o.w, 0.16, o.d, o.color),
            boxMesh(Math.min(0.8, o.w * 0.3), 0.12, Math.min(0.8, o.d * 0.35), '#151618', 0, 0.14, 0),
            headerRow(o.front.length, P, -((o.front.length - 1) * P) / 2, 0.08, zf),
            ...(o.back ? [headerRow(o.back.length, P, -((o.back.length - 1) * P) / 2, 0.08, zb)] : []),
          ),
        }],
        joints: [],
        pins: [...row(o.front, 0.68, zf, kinds, extra), ...(o.back ? row(o.back, 0.68, zb, kinds, extra) : [])],
      };
    },
  };
}

export const servoDriver = breakout({
  id: 'pca9685', name: 'Servo driver (PCA9685)', color: '#1f5fbf', w: 6.2, d: 2.5, mass: 9,
  description: '16 servo / PWM outputs over I2C (2 wires for 16 servos). S0-S15 carry the signals; feed the servos\' power from your own supply. OE: leave it unwired, or LOW = outputs on, HIGH = all off.',
  front: ['GND', 'OE', 'SCL', 'SDA', 'VCC'],
  back: Array.from({ length: 16 }, (_, i) => `S${i}`),
  kinds: { OE: 'in', ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`S${i}`, 'out'])) },
  extra: { OE: { label: 'OE (outputs on when LOW or unwired)', pulled: 'down' } },
  addrs: [0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47],
});
export const motionSensor = breakout({
  id: 'mpu6050', name: 'Motion sensor (MPU-6050)', category: 'Sensors', color: '#2f6fd1', w: 2.1, d: 1.6, mass: 2,
  description: 'Accelerometer and gyroscope over I2C: feels gravity, tilting and turning of whatever it is glued to. X = its long side, Z = up out of the board.',
  front: ['VCC', 'GND', 'SCL', 'SDA'],
  addrs: [0x68, 0x69],
});
export const ioExpander = breakout({
  id: 'mcp23017', name: 'IO expander (MCP23017)', color: '#2b2d33', w: 5.0, d: 2.2, mass: 4,
  description: '16 extra on/off pins over I2C (A0-A7, B0-B7), each an input (with optional pull-up) or an output.',
  front: ['VCC', 'GND', 'SCL', 'SDA', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'],
  back: ['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'],
  addrs: [0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27],
});
export const adcModule = breakout({
  id: 'ads1115', name: 'Analog inputs (ADS1115)', category: 'Sensors', color: '#1f5fbf', w: 2.8, d: 1.8, mass: 2,
  description: '4 precise (16-bit) analog inputs over I2C, measuring 0 V up to its supply on AIN0-AIN3.',
  front: ['VCC', 'GND', 'SCL', 'SDA', 'AIN0', 'AIN1', 'AIN2', 'AIN3'],
  kinds: { AIN0: 'in', AIN1: 'in', AIN2: 'in', AIN3: 'in' },
  extra: { AIN0: { analog: true }, AIN1: { analog: true }, AIN2: { analog: true }, AIN3: { analog: true } },
  addrs: [0x48, 0x49, 0x4a, 0x4b],
});
export const powerMeter = breakout({
  id: 'ina226', name: 'Power meter (INA226)', category: 'Sensors', color: '#7b3fa0', w: 2.6, d: 2.0, mass: 3,
  description: 'Measures the voltage and current of a supply passing through it: wire the supply to IN+ and the load to IN- (IN+ and IN- are joined through its 0.1 ohm shunt). Reads over I2C.',
  front: ['VCC', 'GND', 'SCL', 'SDA'],
  back: ['IN+', 'IN-'],
  kinds: { 'IN+': 'vin', 'IN-': 'vout' },
  extra: { 'IN+': { vmax: 36 } },
  addrs: [0x40, 0x41, 0x44, 0x45],
});
export const eeprom = breakout({
  id: 'eeprom-24c02', name: 'Memory (24C02 EEPROM)', color: '#2b2d33', w: 1.8, d: 1.5, mass: 1,
  description: '256 bytes that remember what you write to them over I2C (until the run ends).',
  front: ['VCC', 'GND', 'SCL', 'SDA'],
  addrs: [0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57],
});

// ------------------------------------------------------------------------------------------ RP2040 board
// Pin numbers here are the chip's own (GP0-GP28); a program (.uf2) sees exactly those.
const rpLeft = ['GP0', 'GP1', 'GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GND2', 'GP6', 'GP7', 'GP8', 'GP9', 'GND3', 'GP10', 'GP11', 'GP12', 'GP13', 'GND4', 'GP14', 'GP15'];
const rpRight = ['VBUS', 'VSYS', 'GND5', 'EN', '3V3', 'GP28', 'GND6', 'GP27', 'GP26', 'RUN', 'GP22', 'GND7', 'GP21', 'GP20', 'GP19', 'GP18', 'GND8', 'GP17', 'GP16', 'GND9'];
export const RP2040_GROUNDS = [...rpLeft, ...rpRight].filter((p) => p.startsWith('GND'));

export const rp2040Board: PartType = {
  id: 'rp2040-board',
  name: 'RP2040 board (.uf2)',
  category: 'Boards',
  description: 'A real RP2040 microcontroller, emulated: it runs the same .uf2 file you would drag onto the real chip (Arduino, Pico SDK, MicroPython, CircuitPython builds). Select it, then Program > Load .uf2. GP25 is its on-board LED; its USB serial shows in the serial monitor.',
  swatch: '#2e7d4f',
  programmable: 'rp2040',
  params: [{ key: 'usb', label: 'USB cable plugged in (5 V)', kind: 'bool' }],
  defaults: { usb: true },
  build: () => {
    const w = 2.1, l = 5.1;
    const led = boxMesh(0.15, 0.08, 0.25, '#30d158', -0.55, 0.2, -l / 2 + 0.6);
    led.userData.builtinLed = true;
    const kinds: Record<string, PinDef['kind']> = { VBUS: 'vout', VSYS: 'vin', '3V3': 'vout', EN: 'in', RUN: 'in' };
    for (const g of RP2040_GROUNDS) kinds[g] = 'gnd';
    const extra: Record<string, Partial<PinDef>> = { VSYS: { label: 'VSYS (1.8-5.5 V in)', vmin: 1.8, vmax: 5.5 }, GP26: { analog: true }, GP27: { analog: true }, GP28: { analog: true }, RUN: { pulled: 'up' }, EN: { pulled: 'up' } };
    const pins: PinDef[] = [];
    // the two long edges, pin 1 at the USB end (-z)
    const z0 = -((rpLeft.length - 1) * P) / 2;
    rpLeft.forEach((id, i) => pins.push({ id, body: 'body', pos: [-w / 2 + 0.15, 0.68, z0 + i * P], kind: kinds[id] ?? 'io', ...(extra[id] ?? {}) }));
    rpRight.forEach((id, i) => pins.push({ id, body: 'body', pos: [w / 2 - 0.15, 0.68, z0 + i * P], kind: kinds[id] ?? 'io', ...(extra[id] ?? {}) }));
    const header = (x: number) => {
      const g = headerRow(20, P, z0, 0.08, 0);
      g.rotation.y = -Math.PI / 2;
      g.position.x = x;
      return g;
    };
    return {
      bodies: [{
        name: 'body', pos: [0, 0.08, 0], mass: 3,
        colliders: [{ shape: { kind: 'box', hx: w / 2, hy: 0.08, hz: l / 2 } }],
        visual: group(
          boxMesh(w, 0.16, l, '#2e7d4f'),
          boxMesh(0.7, 0.1, 0.7, '#151618', 0, 0.13, 0.2), // the chip
          boxMesh(0.8, 0.3, 0.55, '#b9bec7', 0, 0.23, -l / 2 + 0.25), // USB socket
          boxMesh(0.5, 0.12, 0.35, '#e9e9e9', 0.5, 0.14, -l / 2 + 1.0), // BOOTSEL button
          led,
          header(-w / 2 + 0.15),
          header(w / 2 - 0.15),
        ),
      }],
      joints: [],
      pins,
    };
  },
};

// ------------------------------------------------------------------------------------------ ESP32 board
// Laid out like the common 38-pin ESP32 dev boards; pin names are the chip's GPIO numbers, so sketches
// written for one (pinMode(2, OUTPUT), Wire on 21/22, WiFi, WebServer) work as they are.
const espLeft = ['3V3', 'EN', 'VP', 'VN', 'IO34', 'IO35', 'IO32', 'IO33', 'IO25', 'IO26', 'IO27', 'IO14', 'IO12', 'GND', 'IO13', 'SD2', 'SD3', 'CMD', '5V'];
const espRight = ['GND2', 'IO23', 'IO22', 'TX', 'RX', 'IO21', 'GND3', 'IO19', 'IO18', 'IO5', 'IO17', 'IO16', 'IO4', 'IO0', 'IO2', 'IO15', 'SD1', 'SD0', 'CLK'];
/** program pin numbers of the ESP32 board's pins (the flash pins SD0-SD3/CMD/CLK can't be used) */
export const ESP32_PINS: Record<string, number> = { VP: 36, VN: 39, TX: 1, RX: 3 };
for (const id of [...espLeft, ...espRight]) {
  const m = /^IO(\d+)$/.exec(id);
  if (m) ESP32_PINS[id] = Number(m[1]);
}
export const ESP32_ANALOG = ['VP', 'VN', 'IO32', 'IO33', 'IO34', 'IO35'];

export const esp32Board: PartType = {
  id: 'esp32-board',
  name: 'ESP32 board (Wi-Fi)',
  category: 'Boards',
  description: 'An ESP32 dev board with Wi-Fi, programmed with Arduino-style sketches in the app. It joins the bench\'s Wi-Fi (WiFi.begin with the name and password in the project settings) and can serve web pages (WebServer): while it runs, select it and press "Open its web page". GPIO numbers as printed (IO2 = 2, its LED); I2C on 21 (SDA) / 22 (SCL); analog on 32-39.',
  swatch: '#2b2d33',
  programmable: 'sketch',
  params: [{ key: 'usb', label: 'USB cable plugged in (5 V)', kind: 'bool' }],
  defaults: { usb: true },
  build: () => {
    const w = 2.8, l = 5.4;
    const led = boxMesh(0.15, 0.08, 0.2, '#4f9cff', 0.55, 0.2, 2.1);
    led.userData.builtinLed = true;
    const kinds: Record<string, PinDef['kind']> = { '3V3': 'vout', '5V': 'vin', GND: 'gnd', GND2: 'gnd', GND3: 'gnd', EN: 'in', SD0: 'io', SD1: 'io', SD2: 'io', SD3: 'io', CMD: 'io', CLK: 'io', IO21: 'i2c', IO22: 'i2c' };
    const extra: Record<string, Partial<PinDef>> = { '5V': { label: '5V (VIN, 4.5-12 V)', vmin: 4.5, vmax: 12.5 }, IO21: { label: 'IO21 (SDA)' }, IO22: { label: 'IO22 (SCL)' }, EN: { label: 'EN (reset when LOW)', pulled: 'up' } };
    for (const a of ESP32_ANALOG) extra[a] = { ...(extra[a] ?? {}), analog: true };
    const z0 = -((espLeft.length - 1) * P) / 2;
    const pins: PinDef[] = [];
    const x = 1.27; // the two rows are an inch apart
    espLeft.forEach((id, i) => pins.push({ id, body: 'body', pos: [-x, 0.68, z0 + i * P], kind: kinds[id] ?? 'io', ...(extra[id] ?? {}) }));
    espRight.forEach((id, i) => pins.push({ id, body: 'body', pos: [x, 0.68, z0 + i * P], kind: kinds[id] ?? 'io', ...(extra[id] ?? {}) }));
    const header = (hx: number) => {
      const g = headerRow(19, P, z0, 0.08, 0);
      g.rotation.y = -Math.PI / 2;
      g.position.x = hx;
      return g;
    };
    return {
      bodies: [{
        name: 'body', pos: [0, 0.08, 0], mass: 9,
        colliders: [{ shape: { kind: 'box', hx: w / 2, hy: 0.08, hz: l / 2 } }],
        visual: group(
          boxMesh(w, 0.16, l, '#24262b'),
          boxMesh(1.8, 0.3, 2.5, '#b9bec7', 0, 0.23, -1.2), // the metal can
          boxMesh(1.8, 0.04, 0.9, '#20563a', 0, 0.1, -2.35), // the antenna
          boxMesh(0.8, 0.3, 0.55, '#b9bec7', 0, 0.23, l / 2 - 0.25), // USB socket
          boxMesh(0.35, 0.15, 0.35, '#e9e9e9', -0.7, 0.16, 2.2), // EN / BOOT buttons
          boxMesh(0.35, 0.15, 0.35, '#e9e9e9', 0.7, 0.16, 1.75),
          led,
          header(-x),
          header(x),
        ),
      }],
      joints: [],
      pins,
    };
  },
};

// ------------------------------------------------------------------------------------------ UNO-layout Wi-Fi board
// Pin for pin like the UNO R4 WiFi (D0-D13, A0-A5 = 14-19, 5 V logic, PWM on 3 5 6 9 10 11, LED on 13,
// WiFiS3: WiFi.begin waits until connected), so sketches written for one run unchanged.
const unoTop = ['SCL', 'SDA', 'AREF', 'GND3', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'];
const unoBottom = ['IOREF', 'RESET', '3V3', '5V', 'GND', 'GND2', 'VIN', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'];
export const UNO_PINS: Record<string, number> = { SDA: 18, SCL: 19 };
for (let i = 0; i <= 13; i++) UNO_PINS[`D${i}`] = i;
for (let i = 0; i <= 5; i++) UNO_PINS[`A${i}`] = 14 + i;
export const UNO_ANALOG = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'];

export const unoWifiBoard: PartType = {
  id: 'uno-wifi-board',
  name: 'Wi-Fi board (UNO layout)',
  category: 'Boards',
  description: 'A Wi-Fi board laid out pin for pin like the UNO R4 WiFi: D0-D13, A0-A5, 5 V logic, PWM on 3, 5, 6, 9, 10, 11, its LED on 13. Sketches for it (#include <WiFiS3.h>, WiFiServer, WiFi.begin waiting until connected) run unchanged. USB powered, or 6-24 V on VIN.',
  swatch: '#1b7a8c',
  programmable: 'sketch',
  params: [{ key: 'usb', label: 'USB cable plugged in (5 V)', kind: 'bool' }],
  defaults: { usb: true },
  build: () => {
    const w = 6.86, d = 5.33;
    const led = boxMesh(0.2, 0.08, 0.12, '#ffb020', -0.6, 0.2, -1.4);
    led.userData.builtinLed = true;
    const kinds: Record<string, PinDef['kind']> = { '3V3': 'vout', '5V': 'vout', IOREF: 'vout', VIN: 'vin', GND: 'gnd', GND2: 'gnd', GND3: 'gnd', SDA: 'i2c', SCL: 'i2c', RESET: 'in', AREF: 'in' };
    const extra: Record<string, Partial<PinDef>> = { VIN: { label: 'VIN (6-24 V)', vmin: 6, vmax: 24 }, RESET: { pulled: 'up' }, AREF: { pulled: 'up' } };
    for (const a of UNO_ANALOG) extra[a] = { analog: true };
    for (const p of ['D3', 'D5', 'D6', 'D9', 'D10', 'D11']) extra[p] = { ...(extra[p] ?? {}), label: `${p} (~PWM)` };
    const at = (ids: string[], z: number, x0: number) => ids.map((id, i) => ({ id, body: 'body', pos: [x0 + i * P, 0.68, z] as [number, number, number], kind: kinds[id] ?? 'io', ...(extra[id] ?? {}) }));
    const topX = -w / 2 + 1.7, botX = -w / 2 + 2.4;
    return {
      bodies: [{
        name: 'body', pos: [0, 0.08, 0], mass: 25,
        colliders: [{ shape: { kind: 'box', hx: w / 2, hy: 0.08, hz: d / 2 } }],
        visual: group(
          boxMesh(w, 0.16, d, '#1b7a8c'),
          boxMesh(1.2, 0.35, 1.2, '#b9bec7', -w / 2 + 0.6, 0.25, -1.2), // USB-C socket
          boxMesh(1.4, 1.1, 0.9, '#1c1d21', -w / 2 + 0.6, 0.6, 1.8), // barrel jack
          boxMesh(1.3, 0.12, 1.3, '#151618', 0.6, 0.14, 0.2), // the chip
          boxMesh(1.2, 0.16, 0.7, '#cfd3da', 2.3, 0.16, 0.2), // Wi-Fi module
          led,
          headerRow(unoTop.length, P, topX, 0.08, -d / 2 + 0.15),
          headerRow(unoBottom.length, P, botX, 0.08, d / 2 - 0.15),
        ),
      }],
      joints: [],
      pins: [...at(unoTop, -d / 2 + 0.15, topX), ...at(unoBottom, d / 2 - 0.15, botX)],
    };
  },
};

export const MODULES: PartType[] = [rp2040Board, esp32Board, unoWifiBoard, servoDriver, motionSensor, ioExpander, adcModule, powerMeter, eeprom];
