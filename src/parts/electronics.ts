// Electronic parts: things with pins that do something when powered and wired.
// (What they DO is in elec/devices.ts; here is their shape and where their pins are.)
import * as THREE from 'three';
import { boxMesh, cylMesh, group, headerRow, mesh } from './geo';
import type { PartType, PinDef } from './types';

const P = 0.254; // 0.1 inch pin pitch, cm

/** pins in a row along X, centred on x=0 */
function pinRow(ids: string[], body: string, y: number, z: number, kinds: Record<string, PinDef['kind']>, extra: Record<string, Partial<PinDef>> = {}): PinDef[] {
  const x0 = -((ids.length - 1) * P) / 2;
  return ids.map((id, i) => ({ id, body, pos: [x0 + i * P, y, z], kind: kinds[id] ?? 'io', ...(extra[id] ?? {}) }));
}

const LED_COLORS: Record<string, string> = { red: '#ff3b30', green: '#30d158', blue: '#2f7bff', yellow: '#ffd60a', white: '#f2f5ff' };

export const led: PartType = {
  id: 'led',
  name: 'LED',
  category: 'Electronics',
  description: 'A 5 mm LED with its resistor built in (so it can go straight on a pin). Long leg A to the + side, K to ground.',
  swatch: '#ff3b30',
  params: [{ key: 'color', label: 'Colour', kind: 'select', options: Object.keys(LED_COLORS).map((c) => ({ value: c, label: c })) }],
  defaults: { color: 'red' },
  build: (p) => {
    const c = LED_COLORS[p.color] ?? '#ff3b30';
    const lens = group(cylMesh(0.25, 0.55, c, 0, 0.4, 0), mesh(new THREE.SphereGeometry(0.25, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), c, 0, 0.675, 0));
    lens.traverse((m) => {
      const mm = m as THREE.Mesh;
      if (mm.isMesh) {
        mm.userData.lens = true;
        (mm.material as THREE.MeshStandardMaterial).transparent = true;
        (mm.material as THREE.MeshStandardMaterial).opacity = 0.85;
      }
    });
    return {
      bodies: [{
        name: 'body', pos: [0, 0, 0], mass: 0.3,
        colliders: [{ shape: { kind: 'cylinder', halfHeight: 0.4, radius: 0.28 }, pos: [0, 0.5, 0] }],
        visual: group(lens, cylMesh(0.3, 0.12, c, 0, 0.1, 0), boxMesh(0.04, 0.12, 0.04, '#cfcfcf', P / 2, 0.02, 0), boxMesh(0.04, 0.12, 0.04, '#cfcfcf', -P / 2, 0.02, 0)),
      }],
      joints: [],
      pins: [
        { id: 'A', label: 'A (+, long leg)', body: 'body', pos: [P / 2, 0.02, 0], kind: 'in' },
        { id: 'K', label: 'K (-, ground)', body: 'body', pos: [-P / 2, 0.02, 0], kind: 'gnd' },
      ],
    };
  },
};

export const button: PartType = {
  id: 'button',
  name: 'Push button',
  category: 'Electronics',
  description: 'A 12 mm push button: connects its two pins while pressed. While running, click it to press it.',
  swatch: '#d9d9d9',
  params: [{ key: 'color', label: 'Cap colour', kind: 'color' }],
  defaults: { color: '#d23b3b' },
  build: (p) => {
    const cap = cylMesh(0.38, 0.3, p.color, 0, 0.5, 0);
    cap.userData.cap = true;
    return {
      bodies: [{
        name: 'body', pos: [0, 0, 0], mass: 1,
        colliders: [{ shape: { kind: 'box', hx: 0.6, hy: 0.25, hz: 0.6 }, pos: [0, 0.25, 0] }],
        visual: group(boxMesh(1.2, 0.35, 1.2, '#2a2c31', 0, 0.175, 0), cap),
      }],
      joints: [],
      pins: [
        { id: '1', body: 'body', pos: [-0.7, 0.15, 0], kind: 'out' },
        { id: '2', body: 'body', pos: [0.7, 0.15, 0], kind: 'out' },
      ],
    };
  },
};

export const knob: PartType = {
  id: 'knob',
  name: 'Knob (potentiometer)',
  category: 'Electronics',
  description: 'A 10k potentiometer: the middle pin W gives a voltage between L and H as you turn it (slider while running). Wire L to GND, H to 3V3, W to an analog pin.',
  swatch: '#4a4f5a',
  params: [{ key: 'start', label: 'Turned to (%)', kind: 'number', min: 0, max: 100, step: 1 }],
  defaults: { start: 50 },
  build: () => ({
    bodies: [{
      name: 'body', pos: [0, 0, 0], mass: 4,
      colliders: [{ shape: { kind: 'box', hx: 0.5, hy: 0.3, hz: 0.5 }, pos: [0, 0.3, 0] }, { shape: { kind: 'cylinder', halfHeight: 0.5, radius: 0.55 }, pos: [0, 1.1, 0] }],
      visual: group(boxMesh(1.0, 0.6, 1.0, '#3a64b8', 0, 0.3, 0), cylMesh(0.22, 0.6, '#c8c8c8', 0, 0.8, 0), cylMesh(0.55, 0.6, '#2a2c31', 0, 1.3, 0), boxMesh(0.08, 0.05, 0.4, '#f2f2f2', 0, 1.62, -0.2)),
    }],
    joints: [],
    pins: pinRow(['L', 'W', 'H'], 'body', 0.1, 0.6, { L: 'out', W: 'out', H: 'out' }),
  }),
};

export const drv8833: PartType = {
  id: 'drv8833',
  name: 'Motor driver (DRV8833)',
  category: 'Electronics',
  description: 'Runs two DC motors from logic pins. VM = motor power (2.7-10.8 V), AIN1/AIN2 set motor A (one HIGH or PWM = turn, both LOW = stop), BIN1/BIN2 motor B.',
  swatch: '#7b3fa0',
  params: [],
  defaults: {},
  build: () => {
    const w = 1.85, d = 1.6; // (the common module: 18 x 16 mm)
    return {
      bodies: [{
        name: 'body', pos: [0, 0.08, 0], mass: 2,
        colliders: [{ shape: { kind: 'box', hx: w / 2, hy: 0.08, hz: d / 2 } }],
        visual: group(boxMesh(w, 0.16, d, '#7b3fa0'), boxMesh(0.5, 0.12, 0.5, '#151618', 0, 0.14, 0), headerRow(6, P, -2.5 * P, 0.08, d / 2 - 0.15), headerRow(4, P, -1.5 * P, 0.08, -d / 2 + 0.15)),
      }],
      joints: [],
      pins: [
        ...pinRow(['VM', 'GND', 'AIN1', 'AIN2', 'BIN1', 'BIN2'], 'body', 0.68, d / 2 - 0.15, { VM: 'vin', GND: 'gnd', AIN1: 'in', AIN2: 'in', BIN1: 'in', BIN2: 'in' }, { VM: { vmin: 2.7, vmax: 10.8 } }),
        ...pinRow(['AOUT1', 'AOUT2', 'BOUT1', 'BOUT2'], 'body', 0.68, -d / 2 + 0.15, { AOUT1: 'motor', AOUT2: 'motor', BOUT1: 'motor', BOUT2: 'motor' }),
      ],
    };
  },
};

export const l298n: PartType = {
  id: 'l298n',
  name: 'Motor driver (L298N)',
  category: 'Electronics',
  description: 'The big red L298N board: two DC motors, 5-35 V on 12V. IN1/IN2 set motor A\'s direction and ENA its speed (PWM, or leave the jumper on for full speed); IN3/IN4 and ENB motor B. It loses about 2 V inside (6 V in gives a motor about 4 V). With 7 V or more on 12V, its 5V pin gives 5 V for a board.',
  swatch: '#c0392b',
  params: [{ key: 'jumpers', label: 'ENA/ENB jumpers on (always full speed)', kind: 'bool' }],
  defaults: { jumpers: false },
  build: () => {
    const w = 4.3, d = 4.3;
    return {
      bodies: [{
        name: 'body', pos: [0, 0.08, 0], mass: 30,
        colliders: [{ shape: { kind: 'box', hx: w / 2, hy: 0.08, hz: d / 2 } }, { shape: { kind: 'box', hx: 1.15, hy: 1.27, hz: 0.7 }, pos: [0, 1.35, -1.05] }],
        visual: group(
          boxMesh(w, 0.16, d, '#c0392b'),
          boxMesh(1.6, 1.8, 0.5, '#151618', 0, 0.98, -0.6), // the chip, screwed to
          boxMesh(2.3, 2.54, 0.15, '#2b2d33', 0, 1.35, -0.93), // its heatsink (the board is 27 mm tall)
          ...[-1.075, -0.645, -0.215, 0.215, 0.645, 1.075].map((x) => boxMesh(0.15, 2.54, 0.75, '#2b2d33', x, 1.35, -1.37)),
          boxMesh(1.1, 0.9, 0.8, '#2f6fd1', -1.55, 0.53, -0.3), // screw terminals
          boxMesh(1.1, 0.9, 0.8, '#2f6fd1', 1.55, 0.53, -0.3),
          boxMesh(1.4, 0.9, 0.8, '#2f6fd1', -0.6, 0.53, 1.6),
          headerRow(6, P, -0.1, 0.08, d / 2 - 0.25),
        ),
      }],
      joints: [],
      pins: [
        { id: 'OUT1', body: 'body', pos: [-1.55, 1.0, -0.6], kind: 'motor' },
        { id: 'OUT2', body: 'body', pos: [-1.55, 1.0, 0.0], kind: 'motor' },
        { id: 'OUT3', body: 'body', pos: [1.55, 1.0, -0.6], kind: 'motor' },
        { id: 'OUT4', body: 'body', pos: [1.55, 1.0, 0.0], kind: 'motor' },
        { id: '12V', label: '12V (motor power, 5-35 V)', body: 'body', pos: [-1.05, 1.0, 1.6], kind: 'vin', vmin: 5, vmax: 35 },
        { id: 'GND', body: 'body', pos: [-0.6, 1.0, 1.6], kind: 'gnd' },
        { id: '5V', label: '5V (out, when 12V is 7 V or more)', body: 'body', pos: [-0.15, 1.0, 1.6], kind: 'vout' },
        ...pinRow(['ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB'], 'body', 0.68, d / 2 - 0.25, { ENA: 'in', IN1: 'in', IN2: 'in', IN3: 'in', IN4: 'in', ENB: 'in' }).map((p) => ({ ...p, pos: [p.pos[0] + 0.535, p.pos[1], p.pos[2]] as [number, number, number] })),
      ],
    };
  },
};

export const hcsr04: PartType = {
  id: 'hcsr04',
  name: 'Distance sensor (HC-SR04)',
  category: 'Sensors',
  description: 'Ultrasonic distance sensor, 2-400 cm, looking straight out of its "eyes". Pulse TRIG for 10 us; ECHO then stays HIGH 58 us per cm (pulseIn). Put it on a front face.',
  swatch: '#2f6fd1',
  params: [],
  defaults: {},
  build: () => {
    const w = 4.5, d = 2.0;
    const eye = (x: number) => group(cylMesh(0.8, 1.2, '#c9ccd2', x, 0.76, 0), cylMesh(0.62, 1.22, '#2b2d33', x, 0.77, 0));
    return {
      bodies: [{
        name: 'body', pos: [0, 0, 0], mass: 9,
        colliders: [
          { shape: { kind: 'box', hx: w / 2, hy: 0.08, hz: d / 2 }, pos: [0, 0.08, 0] },
          { shape: { kind: 'cylinder', halfHeight: 0.6, radius: 0.8 }, pos: [-1.3, 0.76, 0] },
          { shape: { kind: 'cylinder', halfHeight: 0.6, radius: 0.8 }, pos: [1.3, 0.76, 0] },
        ],
        visual: group(boxMesh(w, 0.16, d, '#1f5fbf', 0, 0.08, 0), eye(-1.3), eye(1.3), headerRow(4, P, -1.5 * P, 0.08, -d / 2 + 0.12)),
      }],
      joints: [],
      pins: pinRow(['VCC', 'TRIG', 'ECHO', 'GND'], 'body', 0.68, -d / 2 + 0.12, { VCC: 'vin', TRIG: 'in', ECHO: 'out', GND: 'gnd' }, { VCC: { vmin: 4.5, vmax: 5.5 } }),
    };
  },
};

// The generic programmable board: like an ESP32 / RP2040 dev board, 3.3 V logic.
// Pin numbers in programs: GPn = n, SDA = 20, SCL = 21, A0-A2 = 26-28, LED_BUILTIN = 25.
export const MAKER_PINS: Record<string, number> = {};
const rowA = ['3V3', 'GND', 'GP0', 'GP1', 'GP2', 'GP3', 'GP4', 'GP5', 'GP6', 'GP7', 'GP8', 'GP9', 'GP10', 'GP11', 'GP12'];
const rowB = ['VIN', 'GND2', '5V', 'GP13', 'GP14', 'GP15', 'GP16', 'GP17', 'GP18', 'GP19', 'SDA', 'SCL', 'A0', 'A1', 'A2'];
for (let i = 0; i <= 19; i++) MAKER_PINS[`GP${i}`] = i;
Object.assign(MAKER_PINS, { SDA: 20, SCL: 21, A0: 26, A1: 27, A2: 28 });

export const makerBoard: PartType = {
  id: 'maker-board',
  name: 'Maker board (programmable)',
  category: 'Boards',
  description: 'A microcontroller board you program in the app: 20 GPIO, 3 analog inputs, I2C, PWM on every pin, 3.3 V logic. Powered by its USB (on by default) or 6-12 V on VIN.',
  swatch: '#1c4f9c',
  programmable: 'sketch',
  params: [{ key: 'usb', label: 'USB cable plugged in (5 V)', kind: 'bool' }],
  defaults: { usb: true },
  build: () => {
    const w = 5.2, d = 2.8;
    const ledMesh = boxMesh(0.2, 0.08, 0.12, '#30d158', 1.6, 0.2, 0.7);
    ledMesh.userData.builtinLed = true;
    const kinds: Record<string, PinDef['kind']> = { '3V3': 'vout', GND: 'gnd', GND2: 'gnd', VIN: 'vin', '5V': 'vout', SDA: 'i2c', SCL: 'i2c' };
    const extra: Record<string, Partial<PinDef>> = { VIN: { vmin: 6, vmax: 12.5 }, A0: { analog: true }, A1: { analog: true }, A2: { analog: true } };
    return {
      bodies: [{
        name: 'body', pos: [0, 0.08, 0], mass: 10,
        colliders: [{ shape: { kind: 'box', hx: w / 2, hy: 0.08, hz: d / 2 } }, { shape: { kind: 'box', hx: 0.9, hy: 0.15, hz: 0.9 }, pos: [0.4, 0.23, 0] }],
        visual: group(
          boxMesh(w, 0.16, d, '#1c4f9c'),
          boxMesh(1.8, 0.3, 1.8, '#b9bec7', 0.4, 0.23, 0),
          boxMesh(0.8, 0.3, 0.9, '#c7c9cc', -w / 2 + 0.3, 0.23, 0),
          ledMesh,
          headerRow(15, P, -7 * P, 0.08, d / 2 - 0.15),
          headerRow(15, P, -7 * P, 0.08, -d / 2 + 0.15),
        ),
      }],
      joints: [],
      pins: [...pinRow(rowA, 'body', 0.68, d / 2 - 0.15, kinds, extra), ...pinRow(rowB, 'body', 0.68, -d / 2 + 0.15, kinds, extra)],
    };
  },
};

export const ELECTRONICS: PartType[] = [makerBoard, led, button, knob, drv8833, l298n, hcsr04];
