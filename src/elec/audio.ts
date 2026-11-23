// The Speaker amp (MAX98357A) and the Speaker (parts/audio.ts), running. A board's I2S sound reaches
// the amp as messages on its DIN wire ("raw": a 6-byte header, then 16-bit samples, sketch/worker.ts
// I2S); the amp plays them through the Speaker wired to its + and - (lib/sound.ts pcm), as loud as
// its GAIN and supply make it, and draws the current that takes.
import { benchAudio } from '../lib/sound';
import type { PartView } from '../views';
import type { Circuit, Device } from './circuit';
import { name } from './devices';

/** the I2S messages' first byte (then rate in 3 bytes, channels, bits; then the samples) */
export const I2S_MAGIC = 0xa5;

export function i2sAmpDevice(v: PartView): Device {
  const uid = v.inst.uid;
  let vin = 0, gainDb = 9, mode: 'off' | 'mix' | 'left' | 'right' = 'mix';
  let speakers: string[] = [];
  let c: Circuit | null = null;
  let amps = 0, loud = 0, lastSound = -1, played = 0, rate = 0;
  const level = (pin: string) => (c && c.wired(uid, pin) ? c.v(uid, pin) : null);
  return {
    view: v,
    drive(cc) {
      c = cc;
      vin = cc.supply(uid, 'VIN', 'GND');
      if (vin > 6) cc.warnOnce(`ampv:${uid}`, `${name(v)} gets ${vin.toFixed(1)} V on VIN: at most 5.5 V`, 'bad');
    },
    sense(cc) {
      c = cc;
      // SD: unwired = on, left and right mixed (its pull-up); high = left only; about 1 V = right; low = off
      const sd = level('SD');
      mode = sd === null ? 'mix' : sd < 0.16 ? 'off' : sd > 1.4 ? 'left' : sd > 0.77 ? 'right' : sd > 0.355 ? 'mix' : 'off';
      // GAIN: unwired 9 dB, to GND 12 dB, to VIN 6 dB
      const g = level('GAIN');
      gainDb = g === null ? 9 : g < 0.5 ? 12 : vin > 0 && g > vin - 0.5 ? 6 : 9;
      // the speakers on its + terminal (whose - goes to its -)
      const net = cc.net(uid, 'SPK+');
      speakers = net ? cc.devices.filter((d) => d.view.inst.type === 'speaker' && net.pins.includes(`${d.view.inst.uid}/+`)).map((d) => d.view.inst.uid) : [];
      if (cc.time - lastSound > 0.15) { loud = 0; amps = 0; }
    },
    packets(list) {
      for (const p of list) {
        if (p.pin !== 'DIN' || p.proto !== 'raw' || p.data[0] !== I2S_MAGIC || !c) continue;
        if (vin < 2.5 || mode === 'off') continue;
        if (!c.wired(uid, 'BCLK') || !c.wired(uid, 'LRC')) {
          c.warnOnce(`ampclk:${uid}`, `${name(v)} gets sound on DIN, but its ${!c.wired(uid, 'BCLK') ? 'BCLK' : 'LRC'} isn't wired: without both clocks it can't play (wire them to the pins the program sets)`, 'bad');
          continue;
        }
        const d = p.data;
        rate = d[1] | (d[2] << 8) | (d[3] << 16);
        const chans = Math.max(1, d[4]);
        const frames = Math.floor((d.length - 6) / 2 / chans);
        // (louder with more gain, and with more supply: 3.2 W into 4 ohm at 5 V, 1.4 W at 3.3 V)
        const k = Math.pow(10, (gainDb - 9) / 20) * Math.min(1, vin / 5);
        const out = new Float32Array(frames);
        let sum = 0;
        for (let i = 0; i < frames; i++) {
          const at = 6 + i * 2 * chans;
          const s = (j: number) => { const x = d[at + j * 2] | (d[at + j * 2 + 1] << 8); return (x & 0x8000 ? x - 0x10000 : x) / 32768; };
          const l = s(0), r = chans > 1 ? s(1) : l;
          const x = (mode === 'left' ? l : mode === 'right' ? r : (l + r) / 2) * k;
          out[i] = x;
          sum += x * x;
        }
        played += frames;
        lastSound = c.time;
        const rms = Math.sqrt(sum / Math.max(1, frames));
        loud = rms;
        // (what it takes from VIN: the power into the speaker, ~85% efficient, plus 2.4 mA idle)
        const watts = 3.2 * Math.min(1, (rms / 0.707) ** 2) * (vin / 5) ** 2;
        amps = watts / Math.max(1, vin * 0.85);
        if (!speakers.length) c.warnOnce(`ampspk:${uid}`, `${name(v)} is playing, but no Speaker is wired to its + and - terminals`);
        for (const s of speakers) benchAudio.pcm(`${s}/0`, out, rate);
        if (played === frames) console.info(`[amp] ${name(v)}: sound at ${rate} Hz, ${chans} channel(s), ${mode === 'mix' ? 'left + right' : mode}, ${gainDb} dB, ${speakers.length} speaker(s)`);
      }
    },
    current: () => (vin >= 2.5 ? 0.0024 + amps : 0),
    status: () => [
      vin < 2.5 ? 'no power (2.5-5.5 V on VIN)' : mode === 'off' ? 'off (SD low)' : loud > 0.002 ? `playing ${rate} Hz sound, ${Math.round(Math.min(1, loud * 1.41) * 100)}% loud` : 'on, quiet',
      `gain ${gainDb} dB${mode === 'left' || mode === 'right' ? `, ${mode} channel` : ''}${speakers.length ? '' : ', no speaker wired'}`,
    ],
  };
}

export function speakerDevice(v: PartView): Device {
  const uid = v.inst.uid;
  let direct = false;
  return {
    view: v,
    sense(c) {
      // straight on a board's pin (no amp): tone() still sounds, but a 4 ohm speaker wants an amp
      const net = c.net(uid, '+');
      direct = !!net && !net.pins.some((k) => k.endsWith('/SPK+')) && c.v(uid, '+') !== null;
      if (direct) {
        c.warnOnce(`spkdirect:${uid}`, `${name(v)} is wired straight to a pin: a 4 ohm speaker would pull about 1 A from it, far more than a pin gives (20-40 mA). Put a Speaker amp (or a transistor) in between.`, 'bad');
        const pwm = net!.pwm;
        benchAudio.set(`${uid}/1`, pwm && pwm.hz >= 20 ? [pwm.hz, 0.35, 'square'] : null);
      } else benchAudio.set(`${uid}/1`, null);
    },
    status: () => {
      const l = benchAudio.level(`${uid}/0`);
      return [l.vol > 0.002 ? `playing, ${Math.round(l.vol * 100)}% loud${l.hz ? `, about ${l.hz} Hz` : ''}` : direct ? 'on a pin (needs an amp)' : 'quiet'];
    },
    dispose: () => benchAudio.clear(`${uid}/`),
  };
}
