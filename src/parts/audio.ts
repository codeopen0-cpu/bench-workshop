// Sound out: an I2S amplifier board (MAX98357A) and a speaker for it. What they do: elec/audio.ts.
import { boxMesh, cylMesh, group, headerRow } from './geo';
import type { PartType, PinDef } from './types';

const P = 0.254;

/** MAX98357A: a 3 W class-D amp that takes I2S sound straight from a board (no DAC needed).
 *  As Adafruit's breakout: 19.4 x 17.8 mm, LRC BCLK DIN GAIN SD GND Vin in a row, the speaker's
 *  screw terminal on the far edge. */
export const i2sAmp: PartType = {
  id: 'i2s-amp',
  name: 'Speaker amp (MAX98357A, I2S)',
  category: 'Electronics',
  description: 'A 3 W amplifier that plays sound sent over I2S by an ESP32 (ESP_I2S.h, or driver/i2s.h): wire BCLK, LRC (WS) and DIN to the pins the program sets, VIN to 3.3-5 V, and a Speaker to its + and - terminals. GAIN unwired: 9 dB; to GND: 12 dB; to VIN: 6 dB. SD unwired plays left and right mixed; to VIN: left only; to GND: off. Up to about 0.65 A at full volume from 5 V.',
  swatch: '#2b2b6e',
  params: [],
  defaults: {},
  build: () => {
    const w = 1.94, d = 1.78;
    const ids = ['LRC', 'BCLK', 'DIN', 'GAIN', 'SD', 'GND', 'VIN'];
    const x0 = -((ids.length - 1) * P) / 2;
    const kinds: Record<string, PinDef['kind']> = { VIN: 'vin', GND: 'gnd', LRC: 'in', BCLK: 'in', DIN: 'in', GAIN: 'in', SD: 'in' };
    const pins: PinDef[] = ids.map((id, i) => ({
      id, body: 'body', pos: [x0 + i * P, 0.68, -d / 2 + 0.15] as [number, number, number], kind: kinds[id],
      ...(id === 'VIN' ? { label: 'VIN (2.5-5.5 V)', vmin: 2.5, vmax: 5.5 } : id === 'LRC' ? { label: 'LRC (WS)' } : id === 'GAIN' ? { label: 'GAIN (unwired: 9 dB)' } : id === 'SD' ? { label: 'SD (unwired: on, L+R)' } : {}),
    }));
    pins.push(
      { id: 'SPK+', label: 'Speaker +', body: 'body', pos: [-0.25, 0.55, d / 2 - 0.3], kind: 'out' },
      { id: 'SPK-', label: 'Speaker -', body: 'body', pos: [0.25, 0.55, d / 2 - 0.3], kind: 'out' },
    );
    return {
      bodies: [{
        name: 'body', pos: [0, 0.08, 0], mass: 2,
        colliders: [{ shape: { kind: 'box', hx: w / 2, hy: 0.08, hz: d / 2 } }],
        visual: group(
          boxMesh(w, 0.16, d, '#2b2b6e'),
          boxMesh(0.3, 0.1, 0.3, '#151618', 0, 0.13, 0), // the chip (3 x 3 mm)
          boxMesh(1.0, 0.75, 0.6, '#2f8a3c', 0, 0.455, d / 2 - 0.35), // screw terminal
          cylMesh(0.1, 0.04, '#c9ccd2', -0.25, 0.85, d / 2 - 0.3, 12),
          cylMesh(0.1, 0.04, '#c9ccd2', 0.25, 0.85, d / 2 - 0.3, 12),
          headerRow(ids.length, P, x0, 0.08, -d / 2 + 0.15),
        ),
      }],
      joints: [],
      pins,
    };
  },
};

/** A small speaker: 40 mm, 4 ohm, 3 W, face up. */
export const speaker: PartType = {
  id: 'speaker',
  name: 'Speaker (40 mm, 4 ohm)',
  category: 'Electronics',
  description: 'A 40 mm, 4 ohm, 3 W speaker, face up. Wire its + and - to a Speaker amp (MAX98357A): the sound comes from where it sits (the bench\'s microphones hear it from there). Straight on a board pin it would draw far more than a pin can give: use an amp.',
  swatch: '#26282c',
  params: [],
  defaults: {},
  build: () => ({
    bodies: [{
      name: 'body', pos: [0, 0, 0], mass: 30,
      colliders: [
        { shape: { kind: 'cylinder', halfHeight: 0.45, radius: 1.0 }, pos: [0, 0.45, 0] },
        { shape: { kind: 'cylinder', halfHeight: 0.25, radius: 2.0 }, pos: [0, 1.15, 0] },
      ],
      visual: group(
        cylMesh(1.0, 0.9, '#3a3d42', 0, 0.45, 0, 24), // magnet
        cylMesh(2.0, 0.12, '#1d1f22', 0, 0.96, 0, 32), // frame
        cylMesh(1.85, 0.36, '#2a2c30', 0, 1.2, 0, 32), // cone
        cylMesh(0.55, 0.06, '#191a1c', 0, 1.4, 0, 20), // dust cap
        boxMesh(0.3, 0.08, 0.2, '#c9a24a', 1.9, 1.0, 0.45), // solder tabs
        boxMesh(0.3, 0.08, 0.2, '#c9a24a', 1.9, 1.0, -0.45),
      ),
    }],
    joints: [],
    pins: [
      { id: '+', label: '+ (red)', body: 'body', pos: [1.95, 1.05, 0.45], kind: 'in' },
      { id: '-', label: '-', body: 'body', pos: [1.95, 1.05, -0.45], kind: 'in' },
    ],
  }),
};

export const AUDIO: PartType[] = [i2sAmp, speaker];
