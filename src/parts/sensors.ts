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

export const SENSORS: PartType[] = [acs712, voltageSensor];
