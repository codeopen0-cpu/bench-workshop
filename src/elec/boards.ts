// The boards in parts/boards.ts, running: each a sketchBoard with its pins, ADC, PWM pins, power and
// Wi-Fi as its description says.
import type { PartView } from '../views';
import type { BoardDef } from '../parts/boards';
import { BOARD_DEFS } from '../parts/boards';
import type { Circuit } from './circuit';
import { brownOut, name, overVolt, sketchBoard, type DeviceHooks, type DeviceMaker } from './devices';

function boardDevice(b: BoardDef, v: PartView, hooks: DeviceHooks) {
  const uid = v.inst.uid;
  const vinPin = v.build.pins!.find((p) => p.id === b.power.vin)!;
  let burnt = false;
  return sketchBoard(v, {
    pins: b.pins,
    analog: b.analog,
    logicV: b.logicV,
    adc: b.adc,
    pwmPins: b.pwm?.map((id) => b.pins[id]).filter((n) => n !== undefined),
    builtinLed: b.builtinLed,
    ledActiveLow: b.ledActiveLow,
    wifi: b.wifi,
    ble: b.ble,
    i2s: b.i2s,
    wifiWaits: b.wifiWaits,
    shorts: b.shorts,
    i2c: b.i2c,
    spi: b.spi,
    defines: b.defines,
    constants: b.constants,
    power(c: Circuit) {
      if (v.inst.params.usb) return 1;
      const vin = c.supply(uid, b.power.vin, 'GND');
      if (!burnt && overVolt(c, v, vinPin, vin)) burnt = true;
      const on = !burnt && vin >= b.power.vinMin;
      brownOut(c, v, on, vin, b.power.vinMin, b.power.vin);
      return on ? 1 : 0;
    },
    drivePower(c: Circuit, on: boolean) {
      if (!on) return;
      if (v.inst.params.usb) {
        c.drive(uid, 'GND', { v: 0, strength: 3, src: `${name(v)} GND (USB)` });
        if (b.power.usbPin) c.drive(uid, b.power.usbPin, { v: 5, strength: 2, src: `${name(v)} ${b.power.usbPin} (USB)` });
      }
      for (const p of b.power.out5v ?? []) c.drive(uid, p, { v: 5, strength: 2, src: `${name(v)} ${p}` });
      for (const p of b.power.out3v3 ?? []) c.drive(uid, p, { v: 3.3, strength: 2, src: `${name(v)} ${p}` });
    },
  }, hooks);
}

export const BOARD_DEVICES: Record<string, DeviceMaker> = Object.fromEntries(BOARD_DEFS.map((b) => [b.id, (v: PartView, h: DeviceHooks) => boardDevice(b, v, h)]));
