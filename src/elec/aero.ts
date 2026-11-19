// The ESC: drives a brushless motor (thrusters.ts) from a battery, by a servo signal, as a real one:
// it arms only after seeing a low signal (1000 us) at power-up, it stops if the signal goes away
// (failsafe), and the order of the three phase wires sets which way the motor turns (clockwise as
// wired A-A B-B C-C; two swapped, counter-clockwise), which has to suit its propeller.
import type { PartView } from '../views';
import type { Circuit, Device } from './circuit';
import { name, overVolt } from './devices';

export function escDevice(v: PartView): Device {
  const uid = v.inst.uid;
  const pinBat = v.build.pins!.find((p) => p.id === 'BAT+')!;
  let burnt = false, armed = false, lowFor = 0, lostFor = 0, pulse = 0, throttle = 0, volts = 0;
  let motor: string | null = null, motorName = '', phase: 1 | -1 = 1, spinMismatch = false;
  let wasPowered = false;
  let amps = 0;
  /** the motor on its A / B / C wires, and which way round they go */
  const findMotor = (c: Circuit) => {
    const mine = ['A', 'B', 'C'].map((p) => c.net(uid, p));
    for (const [muid, t] of c.sim.thrusters) {
      const order = ['A', 'B', 'C'].map((p) => { const n = c.net(muid, p); return n ? mine.findIndex((m) => m === n) : -1; });
      const joined = order.filter((i) => i >= 0).length;
      if (!joined) continue;
      if (joined < 3 || new Set(order).size < 3) {
        c.warnOnce(`esc3:${uid}`, `${t.view.inst.name} needs all three of its wires (A, B, C) on ${name(v)}'s A, B, C, one each: it won't turn on fewer`, 'bad');
        return null;
      }
      // the same order round (ABC, BCA, CAB) turns it one way; two swapped, the other way
      const cyclic = (order[1] - order[0] + 3) % 3 === 1 && (order[2] - order[1] + 3) % 3 === 1;
      phase = cyclic ? 1 : -1;
      motorName = t.view.inst.name;
      spinMismatch = phase !== t.def.dir;
      if (spinMismatch && c.time > 0.5) c.warnOnce(`escdir:${uid}`, `${t.view.inst.name} turns ${phase > 0 ? 'clockwise' : 'counter-clockwise'} but its propeller is made for the other way: it pushes weakly, the wrong way. Swap any two of its phase wires (or use the other propeller).`, 'warn');
      return muid;
    }
    return null;
  };
  return {
    view: v,
    shorts: () => [['BAT-', 'GND']],
    drive(c) {
      if (volts >= 6 && !burnt) c.drive(uid, '5V', { v: 5, strength: 2, src: `${name(v)} 5V (BEC)` });
    },
    sense(c, dt) {
      volts = c.supply(uid, 'BAT+', 'BAT-');
      if (!burnt && overVolt(c, v, pinBat, volts)) burnt = true;
      const powered = !burnt && volts >= 6;
      if (powered && !wasPowered) {
        armed = false;
        lowFor = 0;
        console.info(`[esc] ${name(v)} powered (${volts.toFixed(1)} V): waiting for a low signal to arm`);
      }
      wasPowered = powered;
      const n = c.net(uid, 'SIG');
      pulse = n?.pwm && n.v !== null && n.v >= 2 && n.pwm.hz >= 30 && n.pwm.hz <= 500 ? (n.pwm.duty / n.pwm.hz) * 1e6 : 0;
      if (powered && pulse >= 900 && pulse <= 1080) lowFor += dt; else lowFor = 0;
      if (powered && !armed && lowFor >= 0.3) {
        armed = true;
        c.log?.(`${name(v)} armed (beep beep): it now follows the throttle signal`);
        console.info(`[esc] ${name(v)} armed`);
      }
      // failsafe: no signal for half a second (a wire off, the program stopped)
      lostFor = pulse ? 0 : lostFor + dt;
      if (armed && lostFor > 0.5) {
        armed = false;
        c.warnOnce(`escfs:${uid}`, `${name(v)} lost its signal and stopped its motor (failsafe): it needs a low signal again to re-arm`, 'warn');
      }
      if (powered && !armed && pulse > 1100 && c.time > 1) c.warnOnce(`escarm:${uid}`, `${name(v)} won't start: it arms only after seeing a low signal (1000 us) for a moment at power-up. Write 1000 first (in setup, with a short delay), then raise it.`);
      throttle = powered && armed ? Math.max(0, Math.min(1, (pulse - 1060) / (1940 - 1060))) : 0;
      motor = findMotor(c);
      if (powered && !motor && c.time > 0.5 && pulse) c.warnOnce(`escnomotor:${uid}`, `${name(v)} has no brushless motor on its A, B, C wires`);
      const t = motor ? c.sim.setThruster(motor, throttle, powered ? volts : 0, phase) : null;
      // battery current: the propeller's power, through a motor and ESC about 80 % efficient
      amps = t && volts > 0 ? t.power / (volts * 0.8) : 0;
      const rated = Number(v.inst.params.amps) || 30;
      if (amps > rated * 1.2) c.warnOnce(`escamps:${uid}`, `${name(v)} is drawing ${amps.toFixed(0)} A, more than its ${rated} A rating: a real one would burn. Use a bigger ESC, or a smaller propeller.`, 'bad');
    },
    status: () => {
      if (burnt) return ['burnt out'];
      if (volts < 6) return ['no power (needs 7-26 V on BAT+)'];
      const t = motor ? `${motorName}` : 'no motor';
      return [
        armed ? `armed, throttle ${Math.round(throttle * 100)} %` : pulse ? `not armed (signal ${Math.round(pulse)} us: needs 1000 us first)` : 'not armed (no signal)',
        motor ? `${t} turning ${phase > 0 ? 'clockwise' : 'counter-clockwise'}${spinMismatch ? ': its propeller is made for the other way (it pushes weakly, backwards): swap two phase wires' : ''}` : t,
        `${volts.toFixed(1)} V, ${amps.toFixed(1)} A`,
      ];
    },
    current: () => amps + (volts >= 6 ? 0.03 : 0),
  };
}
