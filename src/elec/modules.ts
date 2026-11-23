// What the breakout modules and the RP2040 board do in a run (their shapes: parts/modules.ts).
import * as THREE from 'three';
import { ADS1115, INA226, M24C02, MCP23017, MPU6050, PCA9685 } from '../kit/chips';
import { rp2040Device } from '../kit/rp2040';
import { ESP32_ANALOG, ESP32_PINS, RP2040_GROUNDS, UNO_ANALOG, UNO_PINS } from '../parts/modules';
import type { Project } from '../project';
import { STEP } from '../sim';
import type { PartView } from '../views';
import type { Circuit, Device } from './circuit';
import { brownOut, name, overVolt, sketchBoard, type DeviceHooks, type DeviceMaker } from './devices';

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;

/** VCC/GND supply of a breakout: powered from 2.7 V, burnt above its VCC pin's limit. */
function supply(v: PartView) {
  const vccPin = v.build.pins!.find((p) => p.id === 'VCC')!;
  const s = {
    powered: false,
    volts: 0,
    burnt: false,
    check(c: Circuit) {
      s.volts = c.supply(v.inst.uid, 'VCC', 'GND');
      if (!s.burnt && overVolt(c, v, vccPin, s.volts)) s.burnt = true;
      s.powered = !s.burnt && s.volts >= 2.7;
    },
    off: () => (s.burnt ? 'burnt out' : `no power (VCC ${s.volts.toFixed(1)} V)`),
  };
  return s;
}

/** The accelerometer/gyro readings a sensor glued to this part feels (sensor X = part +x, Y = part -z, Z = up). */
export function imuFeeler(uid: string, body = 'body') {
  let lastVel: THREE.Vector3 | null = null;
  return (c: Circuit, mpu: MPU6050) => {
    const m = motionOf(c, uid, body, lastVel);
    if (!m) return;
    lastVel = m.vel;
    mpu.set(m.accel.x, -m.accel.z, m.accel.y, m.gyro.x, -m.gyro.z, m.gyro.y);
  };
}

/** What a motion sensor on a part feels: acceleration in g and turning in deg/s, both in the part's
 *  own frame (as glued on: turned parts feel turned axes). A resting part feels 1 g upward. */
export function motionOf(c: Circuit, uid: string, body: string, lastVel: THREE.Vector3 | null) {
  const pose = c.sim.poseOf(uid, body);
  if (!pose) return null;
  const acc = lastVel ? pose.vel.clone().sub(lastVel).divideScalar(STEP) : new THREE.Vector3();
  const inv = pose.quat.clone().invert();
  // (a still part feels gravity pushing it up: 1 g on Earth, less on the Moon)
  const accel = acc.add(new THREE.Vector3(0, c.sim.g, 0)).applyQuaternion(inv).divideScalar(981);
  const gyro = pose.spin.clone().applyQuaternion(inv).multiplyScalar(180 / Math.PI);
  return { accel, gyro, vel: pose.vel, pose };
}

function servoDriverDevice(v: PartView): Device {
  const uid = v.inst.uid;
  const s = supply(v);
  const pca = new PCA9685(Number(v.inst.params.addr ?? 0x40));
  pca.enabled = () => s.powered;
  return {
    view: v,
    i2c: { sda: 'SDA', scl: 'SCL', chips: [pca] },
    drive(c) {
      s.check(c);
      // OE has a pull-down on the board: unwired or LOW = outputs on
      const enabled = s.powered && c.level(uid, 'OE') !== 1 && !pca.sleeping;
      for (let ch = 0; ch < 16; ch++) {
        const d = enabled ? pca.duty(ch) : 0;
        c.drive(uid, `S${ch}`, { v: d > 0 ? s.volts : 0, strength: 1, logic: true, src: `${name(v)} S${ch}`, pwm: d > 0 && d < 1 ? { hz: pca.hz, duty: d } : undefined });
      }
    },
    status: () => [s.powered ? `PCA9685 at ${hex(pca.addr)}: ${pca.sleeping ? 'asleep (MODE1 sleep bit set)' : `${Math.round(pca.hz)} Hz`}` : s.off()],
    current: () => (s.powered ? 0.01 : 0),
  };
}

function motionSensorDevice(v: PartView): Device {
  const s = supply(v);
  const mpu = new MPU6050(Number(v.inst.params.addr ?? 0x68));
  mpu.enabled = () => s.powered;
  const feel = imuFeeler(v.inst.uid);
  return {
    view: v,
    i2c: { sda: 'SDA', scl: 'SCL', chips: [mpu] },
    drive: (c) => s.check(c),
    sense: (c) => feel(c, mpu),
    status: () => [s.powered ? `MPU-6050 at ${hex(mpu.addr)}` : s.off()],
    current: () => (s.powered ? 0.004 : 0),
  };
}

function ioExpanderDevice(v: PartView): Device {
  const uid = v.inst.uid;
  const s = supply(v);
  const mcp = new MCP23017(Number(v.inst.params.addr ?? 0x20));
  mcp.enabled = () => s.powered;
  const io = [...Array.from({ length: 8 }, (_, i) => `A${i}`), ...Array.from({ length: 8 }, (_, i) => `B${i}`)];
  return {
    view: v,
    i2c: { sda: 'SDA', scl: 'SCL', chips: [mcp] },
    drive(c) {
      s.check(c);
      if (!s.powered) return;
      const dir = mcp.dir, pu = mcp.pullups, lat = mcp.latch;
      io.forEach((pin, i) => {
        const bit = 1 << i;
        if (!(dir & bit)) c.drive(uid, pin, { v: lat & bit ? s.volts : 0, strength: 1, logic: true, src: `${name(v)} ${pin}` });
        else if (pu & bit) c.drive(uid, pin, { v: s.volts, strength: 0, src: `${name(v)} ${pin} pull-up` });
      });
    },
    sense(c) {
      let inp = 0;
      io.forEach((pin, i) => {
        if (c.level(uid, pin) === 1) inp |= 1 << i;
      });
      mcp.inputs = inp;
    },
    status: () => [s.powered ? `MCP23017 at ${hex(mcp.addr)}` : s.off()],
    current: () => (s.powered ? 0.002 : 0),
  };
}

function adcDevice(v: PartView): Device {
  const uid = v.inst.uid;
  const s = supply(v);
  let circ: Circuit | null = null;
  const ins = ['AIN0', 'AIN1', 'AIN2', 'AIN3'];
  const ads = new ADS1115(Number(v.inst.params.addr ?? 0x48), (ch) => (circ ? Math.min(s.volts, circ.avg(uid, ins[ch])) : 0));
  ads.enabled = () => s.powered;
  return {
    view: v,
    i2c: { sda: 'SDA', scl: 'SCL', chips: [ads] },
    drive: (c) => s.check(c),
    sense(c) {
      circ = c;
      ads.tick();
    },
    status: () => [s.powered ? `ADS1115 at ${hex(ads.addr)}: ${ins.map((p) => `${p} ${(circ?.avg(uid, p) ?? 0).toFixed(2)} V`).join(', ')}` : s.off()],
    current: () => (s.powered ? 0.001 : 0),
  };
}

function powerMeterDevice(v: PartView): Device {
  const uid = v.inst.uid;
  const s = supply(v);
  const ina = new INA226(Number(v.inst.params.addr ?? 0x40));
  ina.enabled = () => s.powered;
  let bus = 0, amps = 0;
  const dev: Device = {
    view: v,
    shorts: () => [['IN+', 'IN-']], // the 0.1 ohm shunt: as good as a wire here
    i2c: { sda: 'SDA', scl: 'SCL', chips: [ina] },
    drive: (c) => s.check(c),
    sense(c) {
      bus = Math.max(0, c.supply(uid, 'IN-', 'GND'));
      // the current: what the parts on the measured line draw
      const net = c.net(uid, 'IN-');
      amps = 0;
      if (net)
        for (const d of c.devices)
          if (d !== dev && d.current && net.pins.some((k) => k.startsWith(d.view.inst.uid + '/'))) amps += d.current();
      ina.update(bus, amps);
    },
    status: () => [s.powered ? `INA226 at ${hex(ina.addr)}: ${bus.toFixed(2)} V, ${(amps * 1000).toFixed(0)} mA` : s.off()],
    current: () => (s.powered ? 0.001 : 0),
  };
  return dev;
}

function eepromDevice(v: PartView): Device {
  const s = supply(v);
  const mem = new M24C02(Number(v.inst.params.addr ?? 0x50));
  mem.enabled = () => s.powered;
  return {
    view: v,
    i2c: { sda: 'SDA', scl: 'SCL', chips: [mem] },
    drive: (c) => s.check(c),
    status: () => [s.powered ? `24C02 at ${hex(mem.addr)}` : s.off()],
    current: () => (s.powered ? 0.001 : 0),
  };
}

/** The RP2040 board: USB (5 V) or VSYS feeds its 3.3 V regulator. */
function rp2040BoardDevice(v: PartView, hooks: DeviceHooks, project: Project): Device {
  const uid = v.inst.uid;
  const vsys = v.build.pins!.find((p) => p.id === 'VSYS')!;
  let burnt = false, vin = 0;
  const grounds = RP2040_GROUNDS.slice(1).map((g) => [RP2040_GROUNDS[0], g] as [string, string]);
  const dev = rp2040Device(v, {
    pinOf: (n) => (n <= 22 || (n >= 26 && n <= 28) ? `GP${n}` : undefined),
    defaultFirmware: { url: '/firmware/rp2040-demo.uf2', name: 'the demo program (blink GP25, I2C scan on GP4/GP5)' },
    drivePower(c) {
      if (v.inst.params.usb) {
        c.drive(uid, 'GND', { v: 0, strength: 3, src: `${name(v)} GND (USB)` });
        c.drive(uid, 'VBUS', { v: 5, strength: 2, src: `${name(v)} VBUS (USB)` });
      }
    },
    power(c) {
      vin = v.inst.params.usb ? 5 : c.supply(uid, 'VSYS', 'GND');
      if (!burnt && !v.inst.params.usb && overVolt(c, v, vsys, vin)) burnt = true;
      const on = !burnt && vin >= 1.8;
      if (on) c.drive(uid, '3V3', { v: 3.3, strength: 2, src: `${name(v)} 3V3` });
      return on;
    },
  }, hooks, project);
  dev.shorts = () => [...grounds, ...(v.inst.params.usb ? [['VBUS', 'VSYS'] as [string, string]] : [])];
  return dev;
}

/** The ESP32 board: USB or 5V (VIN) feeds its 3.3 V regulator; it has Wi-Fi. */
function esp32Device(v: PartView, hooks: DeviceHooks): Device {
  const uid = v.inst.uid;
  const vinPin = v.build.pins!.find((p) => p.id === '5V')!;
  let burnt = false;
  return sketchBoard(v, {
    pins: ESP32_PINS,
    analog: ESP32_ANALOG,
    logicV: 3.3,
    builtinLed: 2,
    wifi: true,
    ble: true,
    i2s: true,
    shorts: [['GND', 'GND2'], ['GND', 'GND3']],
    i2c: { sda: 'IO21', scl: 'IO22' },
    spi: { sck: 'IO18', mosi: 'IO23', miso: 'IO19', ss: 'IO5' },
    // (a classic ESP32 on core 3.x, as the Arduino IDE installs today)
    defines: { ESP32: 1, ARDUINO_ARCH_ESP32: 1, CONFIG_IDF_TARGET_ESP32: 1, ESP_ARDUINO_VERSION_MAJOR: 3, ESP_ARDUINO_VERSION_MINOR: 0, ESP_ARDUINO_VERSION_PATCH: 0 },
    constants: { SDA: 21, SCL: 22, A0: 36, A3: 39, A4: 32, A5: 33, A6: 34, A7: 35, TX: 1, RX: 3, BUILTIN_LED: 2, __RX2: 16, __TX2: 17 },
    power(c) {
      if (v.inst.params.usb) return 1;
      const vin = c.supply(uid, '5V', 'GND');
      if (!burnt && overVolt(c, v, vinPin, vin)) burnt = true;
      brownOut(c, v, !burnt && vin >= 4.5, vin, 4.5, '5V (VIN)');
      return !burnt && vin >= 4.5 ? 1 : 0;
    },
    drivePower(c, on) {
      if (!on) return;
      if (v.inst.params.usb) {
        c.drive(uid, 'GND', { v: 0, strength: 3, src: `${name(v)} GND (USB)` });
        c.drive(uid, '5V', { v: 5, strength: 2, src: `${name(v)} 5V (USB)` });
      }
      c.drive(uid, '3V3', { v: 3.3, strength: 2, src: `${name(v)} 3V3` });
    },
  }, hooks);
}

/** The UNO-layout Wi-Fi board: USB, or 6-24 V on VIN into its regulator; 5 V logic; Wi-Fi like WiFiS3. */
function unoWifiDevice(v: PartView, hooks: DeviceHooks): Device {
  const uid = v.inst.uid;
  const vinPin = v.build.pins!.find((p) => p.id === 'VIN')!;
  let burnt = false;
  return sketchBoard(v, {
    pins: UNO_PINS,
    analog: UNO_ANALOG,
    logicV: 5,
    builtinLed: 13,
    ledMatrix: true,
    ble: true,
    wifi: true,
    wifiWaits: true,
    shorts: [['GND', 'GND2'], ['GND', 'GND3'], ['SDA', 'A4'], ['SCL', 'A5']], // (SDA/SCL are A4/A5 on this layout)
    i2c: { sda: 'SDA', scl: 'SCL' },
    spi: { sck: 'D13', mosi: 'D11', miso: 'D12', ss: 'D10' },
    defines: { ARDUINO_ARCH_RENESAS: 1, ARDUINO_UNOR4_WIFI: 1 },
    constants: { __RX1: 0, __TX1: 1, LED_BUILTIN: 13, SDA: 18, SCL: 19, A0: 14, A1: 15, A2: 16, A3: 17, A4: 18, A5: 19 },
    power(c) {
      if (v.inst.params.usb) return 1;
      const vin = c.supply(uid, 'VIN', 'GND');
      if (!burnt && overVolt(c, v, vinPin, vin)) burnt = true;
      brownOut(c, v, !burnt && vin >= 6, vin, 6);
      return !burnt && vin >= 6 ? 1 : 0;
    },
    drivePower(c, on) {
      if (!on) return;
      if (v.inst.params.usb) c.drive(uid, 'GND', { v: 0, strength: 3, src: `${name(v)} GND (USB)` });
      c.drive(uid, '5V', { v: 5, strength: 2, src: `${name(v)} 5V` });
      c.drive(uid, 'IOREF', { v: 5, strength: 2, src: `${name(v)} IOREF` });
      c.drive(uid, '3V3', { v: 3.3, strength: 2, src: `${name(v)} 3V3` });
    },
  }, hooks);
}

export const MODULE_DEVICES: Record<string, DeviceMaker> = {
  'uno-wifi-board': (v, h) => unoWifiDevice(v, h),
  'esp32-board': (v, h) => esp32Device(v, h),
  pca9685: (v) => servoDriverDevice(v),
  mpu6050: (v) => motionSensorDevice(v),
  mcp23017: (v) => ioExpanderDevice(v),
  ads1115: (v) => adcDevice(v),
  ina226: (v) => powerMeterDevice(v),
  'eeprom-24c02': (v) => eepromDevice(v),
  'rp2040-board': (v, h, p) => rp2040BoardDevice(v, h, p),
};
