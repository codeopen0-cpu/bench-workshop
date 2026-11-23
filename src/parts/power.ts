// Power sources: batteries of different kinds (their voltage, how it sags under load and drops as
// they drain) and a bench power supply. What they do in a run: elec/power.ts.
import * as THREE from 'three';
import { boxMesh, cylMesh, group, mesh } from './geo';
import type { ParamDef, PartType, PinDef } from './types';

export interface Chemistry {
  label: string;
  /** volts of one cell at a state of charge (1 = full, 0 = flat) */
  curve(soc: number): number;
  ohms: number; // internal resistance of one cell
  mAh: number; // capacity of one cell (for the default size), at its rated (small) current
  /** how much less it gives at a bigger current (Peukert): capacity x (ref / amps) ^ (k - 1), never more
   *  than its rating. An alkaline AA gives ~2500 mAh at 25 mA but only ~1200 at 500 mA (Energizer E91). */
  rate?: { ref: number; k: number };
}
export const CHEM: Record<string, Chemistry> = {
  alkaline: { label: 'Alkaline', curve: (s) => 1.0 + 0.58 * Math.pow(s, 0.6), ohms: 0.15, mAh: 2500, rate: { ref: 0.025, k: 1.25 } },
  nimh: { label: 'NiMH rechargeable', curve: (s) => 1.0 + 0.3 * Math.pow(s, 0.25), ohms: 0.03, mAh: 2000, rate: { ref: 0.4, k: 1.05 } },
  lithiumAA: { label: 'Lithium (AA)', curve: (s) => 1.45 + 0.3 * Math.pow(s, 0.2), ohms: 0.1, mAh: 3000, rate: { ref: 0.1, k: 1.04 } },
  liion: { label: 'Li-ion', curve: (s) => 3.0 + 1.2 * Math.pow(s, 0.7), ohms: 0.04, mAh: 3000, rate: { ref: 0.6, k: 1.03 } },
  lipo: { label: 'LiPo', curve: (s) => 3.0 + 1.2 * Math.pow(s, 0.7), ohms: 0.015, mAh: 1000 },
  alk9v: { label: '9 V alkaline', curve: (s) => 1.0 + 0.6 * Math.pow(s, 0.6), ohms: 0.28, mAh: 550, rate: { ref: 0.025, k: 1.3 } }, // six small cells
  coin: { label: 'Lithium coin', curve: (s) => 2.0 + 1.05 * Math.pow(s, 0.35), ohms: 15, mAh: 220, rate: { ref: 0.0002, k: 1.2 } },
};
/** what fraction of its rated capacity a cell gives at this current */
export const rateFactor = (ch: Chemistry, amps: number) => (ch.rate && amps > ch.rate.ref ? Math.pow(ch.rate.ref / amps, ch.rate.k - 1) : 1);

const charge: ParamDef = { key: 'charge', label: 'Charge at the start', kind: 'number', min: 0, max: 100, step: 5, unit: '%' };
const leads = (x: number, y: number, z: number, gap = 0.6): PinDef[] => [
  { id: '+', label: '+ (red)', body: 'body', pos: [x, y, z + gap], kind: 'vout' },
  { id: '-', label: '- (black)', body: 'body', pos: [x, y, z - gap], kind: 'gnd' },
];
const body = (mass: number, w: number, h: number, d: number, visual: THREE.Object3D) => ({
  name: 'body', pos: [0, 0, 0] as [number, number, number], mass,
  colliders: [{ shape: { kind: 'box' as const, hx: w / 2, hy: h / 2, hz: d / 2 }, pos: [0, h / 2, 0] as [number, number, number] }],
  visual,
});

/** AA cells in a holder: 1-8 of them, alkaline / NiMH / lithium. (Its id stays battery-4aa: older projects.) */
export const aaPack: PartType = {
  id: 'battery-4aa',
  name: 'AA battery pack',
  category: 'Power',
  description: 'AA cells in a holder, in series: 1.5 V each (alkaline), 1.2 V (NiMH rechargeable) or 1.7 V (lithium). 4 alkaline = 6 V. About 2500 mAh; they sag a little under heavy loads and drop as they drain.',
  swatch: '#4a8f3c',
  params: [
    { key: 'count', label: 'Cells', kind: 'select', options: ['1', '2', '3', '4', '6', '8'].map((n) => ({ value: n, label: `${n} x AA` })) },
    { key: 'cells', label: 'Type', kind: 'select', options: [{ value: 'alkaline', label: 'Alkaline (1.5 V each)' }, { value: 'nimh', label: 'NiMH rechargeable (1.2 V each)' }, { value: 'lithiumAA', label: 'Lithium (1.7 V each)' }] },
    charge,
  ],
  defaults: { count: '4', cells: 'alkaline', charge: 100 },
  build: (p) => {
    const n = Number(p.count) || 4;
    const rows = n > 4 ? 2 : 1, perRow = Math.ceil(n / rows);
    const d = 5.8, w = perRow * 1.5 + 0.2, h = 1.6 * rows;
    const cells: THREE.Object3D[] = [];
    for (let r = 0; r < rows; r++)
      for (let i = 0; i < perRow && r * perRow + i < n; i++)
        cells.push(mesh(new THREE.CylinderGeometry(0.7, 0.7, d * 0.86, 20), '#4a8f3c', -w / 2 + 0.85 + i * 1.5, 0.8 + r * 1.5, 0).rotateX(Math.PI / 2));
    return {
      pins: leads(w / 2 + 0.3, 0.5, 0),
      bodies: [body(25 + 24 * n, w, h, d, group(boxMesh(w, 0.8, d, '#2b2d33', 0, 0.4, 0), ...cells))],
      joints: [],
    };
  },
};

export const nineVolt: PartType = {
  id: 'battery-9v',
  name: '9 V battery',
  category: 'Power',
  description: 'The rectangular 9 V battery with a snap clip. Only ~550 mAh and about 1.7 ohm inside: fine for small boards, sensors and LEDs, but its voltage collapses under motors.',
  swatch: '#d9a02a',
  params: [charge],
  defaults: { charge: 100 },
  build: () => ({
    pins: leads(1.5, 0.6, 2.7, 0.35),
    bodies: [body(46, 2.6, 1.75, 4.85, group(boxMesh(2.6, 1.75, 4.85, '#d9a02a', 0, 0.875, 0), boxMesh(2.62, 1.77, 1.2, '#1c1d21', 0, 0.875, -1.8), boxMesh(1.4, 0.5, 0.5, '#222', 0, 0.8, 2.6)))],
    joints: [],
  }),
};

export const coinCell: PartType = {
  id: 'battery-cr2032',
  name: 'Coin cell (CR2032)',
  category: 'Power',
  description: 'A 3 V lithium coin cell in a holder. 220 mAh, but about 15 ohm inside: a few milliamps at most. Good for a tiny sensor or one LED, hopeless for motors (its voltage collapses).',
  swatch: '#c8ccd2',
  params: [charge],
  defaults: { charge: 100 },
  build: () => ({
    pins: leads(1.6, 0.3, 0, 0.4),
    bodies: [body(5, 2.6, 0.6, 2.4, group(boxMesh(2.6, 0.3, 2.4, '#1c1d21', 0, 0.15, 0), cylMesh(1.0, 0.32, '#c8ccd2', 0, 0.46, 0)))],
    joints: [],
  }),
};

export const liionCells: PartType = {
  id: 'battery-18650',
  name: 'Li-ion 18650 cells',
  category: 'Power',
  description: '18650 lithium-ion cells (3.0-4.2 V each, 3.7 V nominal, ~3000 mAh) in a holder, 1 or 2 in series (2 = 7.4 V). They can deliver many amps. Real ones need a protection board and must never be drained flat.',
  swatch: '#3a6fd8',
  params: [{ key: 'count', label: 'Cells in series', kind: 'select', options: [{ value: '1', label: '1 (3.7 V)' }, { value: '2', label: '2 (7.4 V)' }] }, charge],
  defaults: { count: '1', charge: 100 },
  build: (p) => {
    const n = Number(p.count) || 1, w = 2.2 * n + 0.2;
    const cells = Array.from({ length: n }, (_, i) => mesh(new THREE.CylinderGeometry(0.9, 0.9, 6.5, 24), '#3a6fd8', -w / 2 + 1.2 + i * 2.2, 1.0, 0).rotateX(Math.PI / 2));
    return {
      pins: leads(w / 2 + 0.3, 0.5, 0),
      bodies: [body(10 + 47 * n, w, 2, 7.6, group(boxMesh(w, 0.9, 7.6, '#1c1d21', 0, 0.45, 0), ...cells))],
      joints: [],
    };
  },
};

export const lipoPack: PartType = {
  id: 'battery-lipo',
  name: 'LiPo pack',
  category: 'Power',
  description: 'A flat lithium-polymer pack, 1S-4S (3.7 V per cell, 4.2 V full), any capacity. Very low resistance: drives motors well. Check the voltage against your parts: a 3S pack (12.6 V full) burns 5 V modules.',
  swatch: '#7a3fbf',
  params: [
    { key: 'cells', label: 'Cells (S)', kind: 'select', options: [1, 2, 3, 4].map((s) => ({ value: String(s), label: `${s}S (${(3.7 * s).toFixed(1)} V)` })) },
    { key: 'mAh', label: 'Capacity', kind: 'number', min: 100, max: 10000, step: 100, unit: 'mAh' },
    charge,
  ],
  defaults: { cells: '2', mAh: 1500, charge: 100 },
  build: (p) => {
    const s = Number(p.cells) || 2, mAh = Number(p.mAh) || 1500;
    const h = 0.75 * s + 0.2, d = 3.4, w = Math.max(4, 3.6 + mAh / 400); // (2S 1500: 73 x 34 x 17 mm, 83 g)
    return {
      pins: leads(w / 2 + 0.6, h / 2, 0, 0.3),
      bodies: [body(Math.round(mAh * s * 0.025 + 8), w, h, d, group(boxMesh(w, h, d, '#7a3fbf', 0, h / 2, 0), boxMesh(0.6, 0.3, 0.9, '#e8e8e8', w / 2 + 0.3, h / 2, 0)))],
      joints: [],
    };
  },
};

export const powerBank: PartType = {
  id: 'power-bank',
  name: 'USB power bank',
  category: 'Power',
  description: 'A USB power bank: a steady 5 V up to 2.1 A, 10000 mAh (at 3.7 V inside). Draw more than 2.1 A and it switches itself off, as real ones do.',
  swatch: '#2b2d33',
  params: [charge],
  defaults: { charge: 100 },
  build: () => ({
    pins: [
      { id: '+', label: '+ 5V (USB red)', body: 'body', pos: [3.1, 1.0, 0.35], kind: 'vout' },
      { id: '-', label: '- GND (USB black)', body: 'body', pos: [3.1, 1.0, -0.35], kind: 'gnd' },
    ],
    // a 10000 mAh one: 92 x 60 x 22 mm, 180 g
    bodies: [body(180, 6.0, 2.2, 9.2, group(boxMesh(6.0, 2.2, 9.2, '#2b2d33', 0, 1.1, 0), boxMesh(0.2, 0.5, 1.2, '#b9bec7', 3.0, 1.1, 0)))],
    joints: [],
  }),
};

export const benchSupply: PartType = {
  id: 'bench-supply',
  name: 'Bench power supply',
  category: 'Power',
  description: 'A lab power supply: set any voltage (0-30 V) and a current limit. Draw more than the limit and it lowers its voltage to hold the current there (constant current), as real ones do, and shows CC.',
  swatch: '#3a3d44',
  params: [
    { key: 'volts', label: 'Voltage', kind: 'number', min: 0, max: 30, step: 0.1, unit: 'V' },
    { key: 'amps', label: 'Current limit', kind: 'number', min: 0.01, max: 5, step: 0.01, unit: 'A' },
  ],
  defaults: { volts: 5, amps: 1 },
  build: () => {
    // a 30 V switching one: 226 mm deep, 82 wide, 138 tall, 1.34 kg
    const L = 22.6, H = 13.8, W = 8.2, f = L / 2;
    const front = boxMesh(0.05, H - 0.8, W - 0.4, '#1c1d21', f + 0.03, H / 2, 0);
    const knob = (z: number) => cylMesh(0.6, 0.6, '#8a8f99', f + 0.3, 5.2, z).rotateZ(Math.PI / 2);
    return {
      pins: [
        { id: '+', label: '+ (red terminal)', body: 'body', pos: [f + 0.6, 1.8, 1.0], kind: 'vout' },
        { id: '-', label: '- (black terminal)', body: 'body', pos: [f + 0.6, 1.8, -1.0], kind: 'gnd' },
      ],
      bodies: [body(1340, L, H, W, group(boxMesh(L, H, W, '#3a3d44', 0, H / 2, 0), front, boxMesh(0.06, 2.6, 6, '#1d3b2a', f + 0.06, 10.2, 0), knob(-2.2), knob(2.2),
        cylMesh(0.35, 0.6, '#d23b3b', f + 0.3, 1.8, 1.0).rotateZ(Math.PI / 2), cylMesh(0.35, 0.6, '#1c1d21', f + 0.3, 1.8, -1.0).rotateZ(Math.PI / 2)))],
      joints: [],
    };
  },
};

export const POWER: PartType[] = [aaPack, nineVolt, coinCell, liionCells, lipoPack, powerBank, benchSupply];
