// Current and voltage sensor modules (their behaviour: elec/sensors.ts).
import { boxMesh, cylMesh, group, headerRow } from './geo';
import type { PartType, PinDef } from './types';

const P = 0.254;

export const acs712: PartType = {
  id: 'acs712',
  name: 'Current sensor (ACS712)',
  category: 'Sensors',
  description: 'Measures the current going through it: put it in the line (the supply to IP+, the load on IP-; it\'s as good as a wire). OUT is half its supply (2.5 V at 5 V) with no current, and moves by 185 mV per amp (the 5 A version; 100 mV/A for 20 A, 66 mV/A for 30 A), up for current one way and down the other. analogRead it; 5 V on VCC.',
  swatch: '#c0392b',
  params: [{ key: 'range', label: 'Version', kind: 'select', options: [{ value: '5', label: '5 A (185 mV/A)' }, { value: '20', label: '20 A (100 mV/A)' }, { value: '30', label: '30 A (66 mV/A)' }] }],
  defaults: { range: '5' },
  build: () => {
    const w = 3.1, d = 1.3;
    const pins: PinDef[] = [
      { id: 'VCC', body: 'body', pos: [w / 2 - 0.15, 0.68, -P], kind: 'vin', label: 'VCC (5 V)', vmin: 4.5, vmax: 5.5 },
      { id: 'OUT', body: 'body', pos: [w / 2 - 0.15, 0.68, 0], kind: 'out', analog: true },
      { id: 'GND', body: 'body', pos: [w / 2 - 0.15, 0.68, P], kind: 'gnd' },
      { id: 'IP+', body: 'body', pos: [-w / 2 + 0.35, 1.0, -0.3], kind: 'vin', label: 'IP+ (supply side)', vmax: 30 },
      { id: 'IP-', body: 'body', pos: [-w / 2 + 0.35, 1.0, 0.3], kind: 'vout', label: 'IP- (load side)' },
    ];
    const h = headerRow(3, P, 0, 0.08, 0);
    h.rotation.y = -Math.PI / 2;
    h.position.set(w / 2 - 0.15, 0, -P);
    return {
      bodies: [{
        name: 'body', pos: [0, 0.08, 0], mass: 4,
        colliders: [{ shape: { kind: 'box', hx: w / 2, hy: 0.08, hz: d / 2 } }],
        visual: group(
          boxMesh(w, 0.16, d, '#c0392b'),
          boxMesh(0.5, 0.15, 0.5, '#151618', 0.2, 0.15, 0),
          boxMesh(0.9, 0.9, 1.2, '#2a62c8', -w / 2 + 0.5, 0.53, 0), // the screw terminal
          h,
        ),
      }],
      joints: [],
      pins,
    };
  },
};

export const voltageSensor: PartType = {
  id: 'voltage-sensor',
  name: 'Voltage sensor (0-25 V)',
  category: 'Sensors',
  description: 'Two resistors that divide a voltage by 5, so a board can measure up to 25 V (a battery, a motor supply): the voltage to measure on VCC / GND (the screw terminal), S to an analog pin (and - to the board\'s GND). Volts = analogRead x (reference / full scale) x 5.',
  swatch: '#c0392b',
  params: [],
  defaults: {},
  build: () => {
    const w = 2.6, d = 1.4;
    const pins: PinDef[] = [
      { id: 'VCC', body: 'body', pos: [-w / 2 + 0.35, 1.0, -0.3], kind: 'vin', label: 'VCC (the voltage to measure, 0-25 V)', vmax: 30 },
      { id: 'GND', body: 'body', pos: [-w / 2 + 0.35, 1.0, 0.3], kind: 'gnd', label: 'GND (its ground)' },
      { id: 'S', body: 'body', pos: [w / 2 - 0.15, 0.68, -P], kind: 'out', analog: true, label: 'S (a fifth of it)' },
      { id: '+', body: 'body', pos: [w / 2 - 0.15, 0.68, 0], kind: 'io', label: '+ (not connected)' },
      { id: '-', body: 'body', pos: [w / 2 - 0.15, 0.68, P], kind: 'gnd', label: '- (to the board GND)' },
    ];
    const h = headerRow(3, P, 0, 0.08, 0);
    h.rotation.y = -Math.PI / 2;
    h.position.set(w / 2 - 0.15, 0, -P);
    return {
      bodies: [{
        name: 'body', pos: [0, 0.08, 0], mass: 3,
        colliders: [{ shape: { kind: 'box', hx: w / 2, hy: 0.08, hz: d / 2 } }],
        visual: group(
          boxMesh(w, 0.16, d, '#c0392b'),
          cylMesh(0.08, 0.5, '#d9b54a', 0.1, 0.25, -0.2, 8),
          cylMesh(0.08, 0.5, '#d9b54a', 0.4, 0.25, 0.2, 8),
          boxMesh(0.9, 0.9, 1.2, '#2a62c8', -w / 2 + 0.5, 0.53, 0),
          h,
        ),
      }],
      joints: [],
      pins,
    };
  },
};

/** AMG8833: an 8 x 8 thermal camera on I2C, looking up (+Y) from its board. */
export const amg8833: PartType = {
  id: 'amg8833',
  name: 'Thermal camera (AMG8833)',
  category: 'Sensors',
  description: 'An 8 x 8 grid of temperatures (0-80 C, 60 degrees wide, up to about 7 m), looking up from its board: warm things (a Warm object, a hand) show up hotter than the room. I2C at 0x69; the Adafruit_AMG88xx library (begin, readPixels, readThermistor) works as is. 3.3-5 V on VIN.',
  swatch: '#1d4f91',
  params: [{ key: 'addr', label: 'I2C address', kind: 'select', options: [{ value: '105', label: '0x69 (AD0 high, the usual)' }, { value: '104', label: '0x68 (AD0 low)' }] }],
  defaults: { addr: '105' },
  build: () => {
    const w = 2.5, d = 2.5;
    const pins: PinDef[] = ['VIN', 'GND', 'SCL', 'SDA', 'INT'].map((id, i) => ({
      id, body: 'body', pos: [-w / 2 + 0.25 + i * P, 0.68, d / 2 - 0.15] as [number, number, number],
      kind: id === 'VIN' ? 'vin' as const : id === 'GND' ? 'gnd' as const : id === 'INT' ? 'out' as const : 'i2c' as const,
      ...(id === 'VIN' ? { label: 'VIN (3.3-5 V)', vmin: 3, vmax: 5.5 } : {}),
    }));
    const h = headerRow(5, P, -w / 2 + 0.25, 0.08, d / 2 - 0.15);
    const lens = cylMesh(0.32, 0.12, '#3a3f47', 0, 0.62, -0.2, 20);
    lens.userData.amgLens = true;
    return {
      bodies: [{
        name: 'body', pos: [0, 0.08, 0], mass: 3,
        colliders: [{ shape: { kind: 'box', hx: w / 2, hy: 0.08, hz: d / 2 } }],
        visual: group(boxMesh(w, 0.16, d, '#1d4f91'), boxMesh(1.15, 0.42, 0.8, '#c9ccd2', 0, 0.29, -0.2), lens, h),
      }],
      joints: [],
      pins,
    };
  },
};

/** RPLidar A1: a spinning laser that measures all round it, sending each point over serial. */
export const rplidar: PartType = {
  id: 'rplidar-a1',
  name: 'Lidar (RPLidar A1)',
  category: 'Sensors',
  description: 'A laser on a spinning head: the distance all the way round (360 degrees, 15 cm to 12 m, about 5.5 turns and 2000 points a second), in the plane of its head. Its serial (115200 baud) speaks the real RPLidar protocol: the RPLidar Arduino library (begin(Serial1), startScan, waitPoint, getCurrentPoint) works as is. TX to a board RX, RX to its TX; MOTOCTL high (or unwired) spins it; 5 V.',
  swatch: '#26282c',
  params: [],
  defaults: {},
  build: () => {
    const R = 3.5;
    const pins: PinDef[] = [
      { id: '5V', body: 'body', pos: [-R - 0.6, 0.9, -0.5], kind: 'vin', label: '5V', vmin: 4.8, vmax: 5.5 },
      { id: 'GND', body: 'body', pos: [-R - 0.6, 0.9, -0.25], kind: 'gnd' },
      { id: 'TX', body: 'body', pos: [-R - 0.6, 0.9, 0], kind: 'out', label: 'TX (to the board RX)' },
      { id: 'RX', body: 'body', pos: [-R - 0.6, 0.9, 0.25], kind: 'in', label: 'RX (from the board TX)' },
      { id: 'MOTOCTL', body: 'body', pos: [-R - 0.6, 0.9, 0.5], kind: 'in', label: 'MOTOCTL (high: spin)', pulled: 'up' },
    ];
    const head = group(cylMesh(2.9, 1.4, '#1c1d20', 0, 0, 0, 40), boxMesh(1.2, 0.8, 0.9, '#3d4048', 2.0, 0.1, 0));
    head.position.set(0, 3.0, 0);
    head.userData.lidarHead = true;
    return {
      bodies: [{
        name: 'body', pos: [0, 0, 0], mass: 170,
        colliders: [
          { shape: { kind: 'box', hx: R + 0.9, hy: 1.1, hz: R }, pos: [-0.4, 1.1, 0] },
          { shape: { kind: 'cylinder', halfHeight: 0.7, radius: 2.9 }, pos: [0, 3.0, 0] },
        ],
        visual: group(boxMesh(2 * R + 1.8, 2.2, 2 * R, '#26282c', -0.4, 1.1, 0), cylMesh(1.2, 0.6, '#3d4048', 0, 2.4, 0, 24), head, boxMesh(0.6, 0.3, 1.4, '#e8e8e8', -R - 0.6, 0.75, 0)),
      }],
      joints: [],
      pins,
    };
  },
};

/** Something warm, for thermal cameras (and flame / heat tests): a hand, a mug of tea, a heater. */
export const warmObject: PartType = {
  id: 'warm-object',
  name: 'Warm object (heat)',
  category: 'Sensors',
  description: 'A thing at a temperature you set (a hand is about 34 C, a mug of tea 60 C, a candle flame far hotter): what a thermal camera sees. Everything else is at room temperature (22 C).',
  swatch: '#e2583e',
  params: [
    { key: 'temp', label: 'Temperature', kind: 'number', min: -20, max: 300, step: 1, unit: 'C' },
    { key: 'r', label: 'Size (radius)', kind: 'number', min: 0.3, max: 30, step: 0.1, unit: 'cm' },
    { key: 'h', label: 'Height', kind: 'number', min: 0.3, max: 60, step: 0.1, unit: 'cm' },
  ],
  defaults: { temp: 34, r: 4, h: 8 },
  build: (p) => {
    // (redder the warmer, bluer the colder: a hint of what it is)
    const t = Math.max(0, Math.min(1, (Number(p.temp) - 22) / 60));
    const c = Number(p.temp) < 18 ? '#5b8bd6' : `#${[0.85, 0.55 - 0.3 * t, 0.45 - 0.35 * t].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
    return {
      bodies: [{
        name: 'body', pos: [0, p.h / 2, 0], mass: Math.PI * p.r * p.r * p.h * 1,
        colliders: [{ shape: { kind: 'cylinder', halfHeight: p.h / 2, radius: p.r } }],
        visual: cylMesh(p.r, p.h, c, 0, 0, 0, 32),
      }],
      joints: [],
    };
  },
};

export const SENSORS: PartType[] = [acs712, voltageSensor, amg8833, rplidar, warmObject];
