// The current and voltage sensor modules (parts/sensors.ts).
import type { PartView } from '../views';
import type { Device } from './circuit';
import { name } from './devices';

/** ACS712: a hall-effect chip on the current's path: OUT = half its supply + mV per amp. */
export function acs712Device(v: PartView): Device {
  const uid = v.inst.uid;
  const range = Number(v.inst.params.range) || 5;
  const mvPerA = range === 30 ? 66 : range === 20 ? 100 : 185;
  let amps = 0, out = 0, vcc = 0;
  const dev: Device = {
    view: v,
    shorts: () => [['IP+', 'IP-']], // (its copper path: as good as a wire)
    drive(c) {
      vcc = c.supply(uid, 'VCC', 'GND');
      if (vcc < 4) { out = 0; return; }
      // (ratiometric: the zero point and the scale follow its supply)
      out = Math.max(0, Math.min(vcc, vcc / 2 + (mvPerA / 1000) * (vcc / 5) * amps * (1 + (Math.random() - 0.5) * 0.01)));
      c.drive(uid, 'OUT', { v: out, strength: 1, src: `${name(v)} OUT` });
    },
    sense(c) {
      // the current: what the parts on its load side (IP-) draw
      const net = c.net(uid, 'IP-');
      amps = 0;
      if (net)
        for (const d of c.devices)
          if (d !== dev && d.current && net.pins.some((k) => k.startsWith(d.view.inst.uid + '/'))) amps += d.current();
      if (amps > range * 1.1) c.warnOnce(`acs:${uid}`, `${name(v)} carries ${amps.toFixed(1)} A: more than its ${range} A range (its output stops at the rail). Use the 20 A or 30 A version.`);
    },
    status: () => [vcc < 4 ? 'no power (5 V on VCC)' : `${amps.toFixed(3)} A through it: OUT ${out.toFixed(3)} V`],
    current: () => (vcc >= 4 ? 0.01 : 0),
  };
  return dev;
}

/** The 0-25 V sensor: a 30k / 7.5k divider, S = VCC / 5. */
export function voltageSensorDevice(v: PartView): Device {
  const uid = v.inst.uid;
  let s = 0, vin = 0;
  return {
    view: v,
    shorts: () => [['GND', '-']],
    drive(c) {
      vin = Math.max(0, c.supply(uid, 'VCC', 'GND'));
      s = vin / 5;
      // (through 30k + 7.5k: a pin reads it fine)
      c.drive(uid, 'S', { v: s, strength: 1, src: `${name(v)} S` });
    },
    status: () => [`${vin.toFixed(2)} V in: S ${s.toFixed(3)} V`],
    current: () => vin / 37500,
  };
}
