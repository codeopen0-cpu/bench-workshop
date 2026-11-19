// More programmable boards, each laid out pin for pin like the real one, so sketches written for it run
// as they are: Arduino Nano and Mega, ESP8266 (NodeMCU, D1 mini), ESP32-S3 and ESP32-C3, Pico W.
// Each is described as data (its pin rows, what each pin is, its ADC, PWM, power, Wi-Fi, look); one
// builder makes the part, and elec/boards.ts makes it run (sketchBoard).
import { boxMesh, group, headerRow } from './geo';
import type { PartType, PinDef } from './types';

const P = 0.254; // 0.1 inch, cm

export interface BoardDef {
  id: string;
  name: string;
  description: string;
  color: string;
  w: number; // cm across (x)
  d: number; // cm long (z)
  mass: number; // g
  /** header rows: along z at a fixed x (a DIP-style board), or along x at a fixed z (UNO-style) */
  rows: { ids: string[]; along: 'x' | 'z'; at: number; start: number }[];
  /** program pin number of each pin that has one */
  pins: Record<string, number>;
  analog: string[];
  kinds?: Record<string, PinDef['kind']>;
  extra?: Record<string, Partial<PinDef>>;
  /** boxes drawn on top of the board: [w, h, d, colour, x, z] (sitting on its top) */
  look: [number, number, number, string, number, number][];
  /** its on-board LED: where, and its colour */
  led?: [number, number, string];
  // ---- what elec/boards.ts needs to run it
  logicV: number;
  adc: { bits: number; vref: number };
  /** pins analogWrite can dim (default: all) */
  pwm?: string[];
  builtinLed?: number;
  ledActiveLow?: boolean;
  i2c?: { sda: string; scl: string };
  spi?: { sck: string; mosi: string; miso: string; ss?: string };
  defines: Record<string, number>;
  constants?: Record<string, number>;
  wifi?: boolean;
  wifiWaits?: boolean;
  shorts?: [string, string][];
  /** its supply: `vin` takes `vinMin`+ volts (into its regulator); USB feeds `usbPin` with 5 V; it then
   *  puts out 5 V on `out5v` and 3.3 V on `out3v3` */
  power: { vin: string; vinMin: number; usbPin?: string; out5v?: string[]; out3v3?: string[] };
}

const pwmLabel = (ids: string[], extra: Record<string, Partial<PinDef>>) => {
  for (const p of ids) extra[p] = { ...(extra[p] ?? {}), label: extra[p]?.label ?? `${p} (~PWM)` };
};

/** The part of a board described by `b`. */
export function boardPart(b: BoardDef, programmable: 'sketch' = 'sketch'): PartType {
  return {
    id: b.id,
    name: b.name,
    category: 'Boards',
    description: b.description,
    swatch: b.color,
    programmable,
    params: [{ key: 'usb', label: 'USB cable plugged in (5 V)', kind: 'bool' }],
    defaults: { usb: true },
    build: () => {
      const kinds = b.kinds ?? {};
      const extra = { ...(b.extra ?? {}) };
      for (const a of b.analog) extra[a] = { ...(extra[a] ?? {}), analog: true };
      const pins: PinDef[] = [];
      const headers = [];
      for (const r of b.rows) {
        r.ids.forEach((id, i) => {
          const pos: [number, number, number] = r.along === 'z' ? [r.at, 0.68, r.start + i * P] : [r.start + i * P, 0.68, r.at];
          pins.push({ id, body: 'body', pos, kind: kinds[id] ?? 'io', ...(extra[id] ?? {}) });
        });
        if (r.along === 'x') headers.push(headerRow(r.ids.length, P, r.start, 0.08, r.at));
        else {
          const g = headerRow(r.ids.length, P, r.start, 0.08, 0);
          g.rotation.y = -Math.PI / 2;
          g.position.x = r.at;
          headers.push(g);
        }
      }
      const extras = b.look.map(([w, h, d, color, x, z]) => boxMesh(w, h, d, color, x, 0.08 + h / 2, z));
      const leds = [];
      if (b.led) {
        const led = boxMesh(0.15, 0.08, 0.2, b.led[2], b.led[0], 0.2, b.led[1]);
        led.userData.builtinLed = true;
        leds.push(led);
      }
      return {
        bodies: [{
          name: 'body', pos: [0, 0.08, 0], mass: b.mass,
          colliders: [{ shape: { kind: 'box', hx: b.w / 2, hy: 0.08, hz: b.d / 2 } }],
          visual: group(boxMesh(b.w, 0.16, b.d, b.color), ...extras, ...leds, ...headers),
        }],
        joints: [],
        pins,
      };
    },
  };
}

// ------------------------------------------------------------------------------------------ Arduino Nano
const nanoL = ['D13', '3V3', 'AREF', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', '5V', 'RST', 'GND', 'VIN'];
const nanoR = ['D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'GND2', 'RST2', 'D0', 'D1'];
const avrPins = (digital: number, analog: number, firstAnalog: number) => {
  const m: Record<string, number> = {};
  for (let i = 0; i < digital; i++) m[`D${i}`] = i;
  for (let i = 0; i < analog; i++) m[`A${i}`] = firstAnalog + i;
  return m;
};
const AVR_POWER_KINDS: Record<string, PinDef['kind']> = { '3V3': 'vout', '5V': 'vout', IOREF: 'vout', VIN: 'vin', RST: 'in', RST2: 'in', RESET: 'in', AREF: 'in' };
const nanoExtra: Record<string, Partial<PinDef>> = {
  VIN: { label: 'VIN (7-12 V)', vmin: 6.5, vmax: 20 }, RST: { pulled: 'up' }, RST2: { pulled: 'up' }, AREF: { pulled: 'up' },
  D0: { label: 'D0 (RX)' }, D1: { label: 'D1 (TX)' }, A4: { label: 'A4 (SDA)' }, A5: { label: 'A5 (SCL)' }, A6: { label: 'A6 (analog only)' }, A7: { label: 'A7 (analog only)' },
};
pwmLabel(['D3', 'D5', 'D6', 'D9', 'D10', 'D11'], nanoExtra);
export const NANO: BoardDef = {
  id: 'arduino-nano', name: 'Arduino Nano', color: '#1f5fbf', w: 1.8, d: 4.5, mass: 7,
  description: 'The classic Arduino Nano (ATmega328P): 5 V logic, D0-D13 and A0-A7 (A6 and A7 read only), PWM on 3, 5, 6, 9, 10, 11, its LED on 13. analogRead gives 0-1023 for 0-5 V. I2C on A4 (SDA) / A5 (SCL); SPI on 13 / 11 / 12. USB, or 7-12 V on VIN.',
  rows: [
    { ids: nanoL, along: 'z', at: -0.762, start: -((nanoL.length - 1) * P) / 2 },
    { ids: nanoR, along: 'z', at: 0.762, start: -((nanoR.length - 1) * P) / 2 },
  ],
  pins: avrPins(14, 8, 14),
  analog: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'],
  kinds: { ...AVR_POWER_KINDS, GND: 'gnd', GND2: 'gnd' },
  extra: nanoExtra,
  look: [[0.7, 0.1, 0.7, '#151618', 0, 0.5], [0.8, 0.35, 0.6, '#b9bec7', 0, -1.95], [0.35, 0.15, 0.35, '#e9e9e9', 0, -0.6]],
  led: [0.45, -1.2, '#ffb020'],
  logicV: 5, adc: { bits: 10, vref: 5 }, pwm: ['D3', 'D5', 'D6', 'D9', 'D10', 'D11'], builtinLed: 13,
  i2c: { sda: 'A4', scl: 'A5' }, spi: { sck: 'D13', mosi: 'D11', miso: 'D12', ss: 'D10' },
  defines: { ARDUINO_ARCH_AVR: 1, ARDUINO_AVR_NANO: 1, __AVR__: 1, __AVR_ATmega328P__: 1, F_CPU: 16000000 },
  constants: { SDA: 18, SCL: 19, LED_BUILTIN: 13 },
  shorts: [['GND', 'GND2'], ['RST', 'RST2']],
  power: { vin: 'VIN', vinMin: 6.5, out5v: ['5V'], out3v3: ['3V3'] },
};

// ------------------------------------------------------------------------------------------ Arduino Mega 2560
const megaW = 10.16, megaD = 5.33;
const megaTop1 = ['SCL', 'SDA', 'AREF', 'GND3', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8'];
const megaTop2 = ['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'];
const megaTop3 = ['D14', 'D15', 'D16', 'D17', 'D18', 'D19', 'D20', 'D21'];
const megaBot1 = ['IOREF', 'RESET', '3V3', '5V', 'GND', 'GND2', 'VIN'];
const megaBot2 = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
const megaBot3 = ['A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15'];
const megaEndA = ['5V2', ...Array.from({ length: 16 }, (_, i) => `D${22 + i * 2}`), 'GND4'];
const megaEndB = ['5V3', ...Array.from({ length: 16 }, (_, i) => `D${23 + i * 2}`), 'GND5'];
const megaPwm = ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'D44', 'D45', 'D46'];
const megaExtra: Record<string, Partial<PinDef>> = {
  VIN: { label: 'VIN (7-12 V)', vmin: 6.5, vmax: 20 }, RESET: { pulled: 'up' }, AREF: { pulled: 'up' },
  D0: { label: 'D0 (RX0)' }, D1: { label: 'D1 (TX0)' }, D14: { label: 'D14 (TX3)' }, D15: { label: 'D15 (RX3)' }, D16: { label: 'D16 (TX2)' }, D17: { label: 'D17 (RX2)' },
  D18: { label: 'D18 (TX1)' }, D19: { label: 'D19 (RX1)' }, D20: { label: 'D20 (SDA)' }, D21: { label: 'D21 (SCL)' },
  D50: { label: 'D50 (MISO)' }, D51: { label: 'D51 (MOSI)' }, D52: { label: 'D52 (SCK)' }, D53: { label: 'D53 (SS)' },
};
pwmLabel(megaPwm, megaExtra);
const t1 = -megaW / 2 + 1.7, t2 = t1 + 9 * P + 0.41, t3 = t2 + 7 * P + 0.41;
const b1 = -megaW / 2 + 2.4, b2 = b1 + 6 * P + 0.66, b3 = b2 + 7 * P + 0.41;
export const MEGA: BoardDef = {
  id: 'arduino-mega', name: 'Arduino Mega 2560', color: '#1f5fbf', w: megaW, d: megaD, mass: 37,
  description: 'The Arduino Mega 2560: 54 digital pins (D0-D53), 16 analog inputs (A0-A15), PWM on 2-13 and 44-46, four serial ports (Serial on 0/1, Serial1 18/19, Serial2 16/17, Serial3 14/15), I2C on 20 (SDA) / 21 (SCL), SPI on 52 / 51 / 50 / 53. 5 V logic; analogRead gives 0-1023. USB, or 7-12 V on VIN.',
  rows: [
    { ids: megaTop1, along: 'x', at: -megaD / 2 + 0.15, start: t1 },
    { ids: megaTop2, along: 'x', at: -megaD / 2 + 0.15, start: t2 },
    { ids: megaTop3, along: 'x', at: -megaD / 2 + 0.15, start: t3 },
    { ids: megaBot1, along: 'x', at: megaD / 2 - 0.15, start: b1 },
    { ids: megaBot2, along: 'x', at: megaD / 2 - 0.15, start: b2 },
    { ids: megaBot3, along: 'x', at: megaD / 2 - 0.15, start: b3 },
    { ids: megaEndA, along: 'z', at: megaW / 2 - 0.6, start: -((megaEndA.length - 1) * P) / 2 },
    { ids: megaEndB, along: 'z', at: megaW / 2 - 0.35, start: -((megaEndB.length - 1) * P) / 2 },
  ],
  pins: avrPins(54, 16, 54),
  analog: [...megaBot2, ...megaBot3],
  kinds: { ...AVR_POWER_KINDS, '5V2': 'vout', '5V3': 'vout', GND: 'gnd', GND2: 'gnd', GND3: 'gnd', GND4: 'gnd', GND5: 'gnd', SDA: 'i2c', SCL: 'i2c' },
  extra: megaExtra,
  look: [[1.4, 0.12, 1.4, '#151618', 0.6, 0.2], [1.2, 1.0, 1.6, '#b9bec7', -megaW / 2 + 0.6, -1.2], [1.4, 1.1, 0.9, '#1c1d21', -megaW / 2 + 0.6, 1.8]],
  led: [-1.6, -1.4, '#ffb020'],
  logicV: 5, adc: { bits: 10, vref: 5 }, pwm: megaPwm, builtinLed: 13,
  i2c: { sda: 'D20', scl: 'D21' }, spi: { sck: 'D52', mosi: 'D51', miso: 'D50', ss: 'D53' },
  defines: { ARDUINO_ARCH_AVR: 1, ARDUINO_AVR_MEGA2560: 1, __AVR__: 1, __AVR_ATmega2560__: 1, F_CPU: 16000000 },
  constants: { SDA: 20, SCL: 21, LED_BUILTIN: 13, __TX1: 18, __RX1: 19, __TX2: 16, __RX2: 17, __TX3: 14, __RX3: 15 },
  shorts: [['GND', 'GND2'], ['GND', 'GND3'], ['GND', 'GND4'], ['GND', 'GND5'], ['5V', '5V2'], ['5V', '5V3'], ['SDA', 'D20'], ['SCL', 'D21']],
  power: { vin: 'VIN', vinMin: 6.5, out5v: ['5V', 'IOREF'], out3v3: ['3V3'] },
};

// ------------------------------------------------------------------------------------------ ESP8266
// D0-D8 are the board's names; programs see the chip's GPIO numbers (D1 = 5), as on the real one.
const ESP8266_PINS: Record<string, number> = { D0: 16, D1: 5, D2: 4, D3: 0, D4: 2, D5: 14, D6: 12, D7: 13, D8: 15, RX: 3, TX: 1, A0: 17 };
const esp8266Extra: Record<string, Partial<PinDef>> = {
  A0: { label: 'A0 (0-3.3 V)' }, D0: { label: 'D0 (GPIO16, no PWM)' }, D1: { label: 'D1 (GPIO5, SCL)' }, D2: { label: 'D2 (GPIO4, SDA)' },
  D3: { label: 'D3 (GPIO0)', pulled: 'up' }, D4: { label: 'D4 (GPIO2, its LED)', pulled: 'up' }, D5: { label: 'D5 (GPIO14, SCK)' }, D6: { label: 'D6 (GPIO12, MISO)' },
  D7: { label: 'D7 (GPIO13, MOSI)' }, D8: { label: 'D8 (GPIO15, SS)', pulled: 'down' }, RX: { label: 'RX (GPIO3)' }, TX: { label: 'TX (GPIO1)' },
  RST: { pulled: 'up' }, EN: { pulled: 'up' },
};
const ESP8266_COMMON = {
  analog: ['A0'],
  logicV: 3.3, adc: { bits: 10, vref: 3.3 }, pwm: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'RX', 'TX'],
  builtinLed: 2, ledActiveLow: true, wifi: true,
  i2c: { sda: 'D2', scl: 'D1' }, spi: { sck: 'D5', mosi: 'D7', miso: 'D6', ss: 'D8' },
  constants: { SDA: 4, SCL: 5, LED_BUILTIN: 2, BUILTIN_LED: 2 },
};
const nmL = ['A0', 'RSV', 'RSV2', 'SD3', 'SD2', 'SD1', 'CMD', 'SD0', 'CLK', 'GND', '3V3', 'EN', 'RST', 'GND2', 'VIN'];
const nmR = ['D0', 'D1', 'D2', 'D3', 'D4', '3V3b', 'GND3', 'D5', 'D6', 'D7', 'D8', 'RX', 'TX', 'GND4', '3V3c'];
export const NODEMCU: BoardDef = {
  id: 'esp8266-nodemcu', name: 'ESP8266 NodeMCU (Wi-Fi)', color: '#24262b', w: 2.6, d: 4.9, mass: 9,
  description: 'An ESP8266 NodeMCU board with Wi-Fi (#include <ESP8266WiFi.h>, ESP8266WebServer): it joins the bench\'s Wi-Fi like an ESP32. Pins named D0-D8 on the board are the chip\'s GPIO numbers in programs (D1 = 5, and D1 works as a name too). One analog input, A0 (0-1023 for 0-3.3 V). Its LED is on D4 (GPIO2) and lights when LOW. I2C on D2 (SDA) / D1 (SCL). USB, or 5 V on VIN.',
  rows: [
    { ids: nmL, along: 'z', at: -1.143, start: -((nmL.length - 1) * P) / 2 },
    { ids: nmR, along: 'z', at: 1.143, start: -((nmR.length - 1) * P) / 2 },
  ],
  pins: { ...ESP8266_PINS, SD2: 9, SD3: 10 },
  kinds: { '3V3': 'vout', '3V3b': 'vout', '3V3c': 'vout', VIN: 'vin', GND: 'gnd', GND2: 'gnd', GND3: 'gnd', GND4: 'gnd', EN: 'in', RST: 'in' },
  extra: { ...esp8266Extra, VIN: { label: 'VIN (4.5-10 V)', vmin: 4.5, vmax: 12 }, '3V3b': { label: '3V3' }, '3V3c': { label: '3V3' } },
  look: [[1.6, 0.3, 1.5, '#b9bec7', 0, -1.2], [1.6, 0.04, 0.6, '#1c3d6b', 0, -2.15], [0.8, 0.3, 0.55, '#b9bec7', 0, 2.2], [0.35, 0.15, 0.35, '#e9e9e9', -0.7, 1.9], [0.35, 0.15, 0.35, '#e9e9e9', 0.7, 1.9]],
  led: [0.55, -0.35, '#4f9cff'],
  ...ESP8266_COMMON,
  defines: { ESP8266: 1, ARDUINO_ARCH_ESP8266: 1, ARDUINO_ESP8266_NODEMCU_ESP12E: 1 },
  shorts: [['GND', 'GND2'], ['GND', 'GND3'], ['GND', 'GND4'], ['3V3', '3V3b'], ['3V3', '3V3c']],
  power: { vin: 'VIN', vinMin: 4.5, usbPin: 'VIN', out3v3: ['3V3'] },
};
const d1L = ['RST', 'A0', 'D0', 'D5', 'D6', 'D7', 'D8', '3V3'];
const d1R = ['TX', 'RX', 'D1', 'D2', 'D3', 'D4', 'GND', '5V'];
export const D1MINI: BoardDef = {
  id: 'esp8266-d1mini', name: 'ESP8266 D1 mini (Wi-Fi)', color: '#1d6b8c', w: 2.56, d: 3.48, mass: 3,
  description: 'The tiny Wemos D1 mini (ESP8266, Wi-Fi): the same chip and names as the NodeMCU (D0-D8 = the chip\'s GPIO numbers, A0 0-1023 for 0-3.3 V, its LED on D4 lights when LOW), on a board the size of a stamp. USB, or 5 V on its 5V pin.',
  rows: [
    { ids: d1L, along: 'z', at: -1.143, start: -((d1L.length - 1) * P) / 2 },
    { ids: d1R, along: 'z', at: 1.143, start: -((d1R.length - 1) * P) / 2 },
  ],
  pins: ESP8266_PINS,
  kinds: { '3V3': 'vout', '5V': 'vin', GND: 'gnd', RST: 'in' },
  extra: { ...esp8266Extra, '5V': { label: '5V (4.5-6 V in)', vmin: 4.5, vmax: 7 } },
  look: [[1.5, 0.3, 1.5, '#b9bec7', 0, -0.6], [1.5, 0.04, 0.4, '#1c3d6b', 0, -1.5], [0.8, 0.3, 0.55, '#b9bec7', 0, 1.5]],
  led: [0.55, -1.0, '#4f9cff'],
  ...ESP8266_COMMON,
  defines: { ESP8266: 1, ARDUINO_ARCH_ESP8266: 1, ARDUINO_ESP8266_WEMOS_D1MINI: 1 },
  power: { vin: '5V', vinMin: 4.5, usbPin: '5V', out3v3: ['3V3'] },
};

// ------------------------------------------------------------------------------------------ ESP32-S3, ESP32-C3
const io = (ids: string[]) => Object.fromEntries(ids.flatMap((id) => (/^IO\d+$/.test(id) ? [[id, Number(id.slice(2))]] : [])));
const ESP32_VERSION = { ESP32: 1, ARDUINO_ARCH_ESP32: 1, ESP_ARDUINO_VERSION_MAJOR: 3, ESP_ARDUINO_VERSION_MINOR: 0, ESP_ARDUINO_VERSION_PATCH: 0 };
const s3L = ['3V3', '3V3b', 'RST', 'IO4', 'IO5', 'IO6', 'IO7', 'IO15', 'IO16', 'IO17', 'IO18', 'IO8', 'IO3', 'IO46', 'IO9', 'IO10', 'IO11', 'IO12', 'IO13', 'IO14', '5V', 'GND'];
const s3R = ['GND2', 'TX', 'RX', 'IO1', 'IO2', 'IO42', 'IO41', 'IO40', 'IO39', 'IO38', 'IO37', 'IO36', 'IO35', 'IO0', 'IO45', 'IO48', 'IO47', 'IO21', 'IO20', 'IO19', 'GND3', 'GND4'];
const s3Analog = ['IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'IO6', 'IO7', 'IO8', 'IO9', 'IO10', 'IO11', 'IO12', 'IO13', 'IO14', 'IO15', 'IO16', 'IO17', 'IO18', 'IO19', 'IO20'];
export const ESP32S3: BoardDef = {
  id: 'esp32s3-board', name: 'ESP32-S3 board (Wi-Fi)', color: '#24262b', w: 2.6, d: 6.3, mass: 10,
  description: 'An ESP32-S3 DevKitC-1 with Wi-Fi: GPIO numbers as printed (IO8 = 8), analog on IO1-IO20 (0-4095), its RGB LED on 48 (LED_BUILTIN / RGB_BUILTIN), I2C on 8 (SDA) / 9 (SCL), SPI on 12 / 11 / 13 / 10, Serial1 on 18 (RX) / 17 (TX). WiFi and WebServer as on an ESP32. USB, or 5 V on its 5V pin.',
  rows: [
    { ids: s3L, along: 'z', at: -1.143, start: -((s3L.length - 1) * P) / 2 },
    { ids: s3R, along: 'z', at: 1.143, start: -((s3R.length - 1) * P) / 2 },
  ],
  pins: { ...io([...s3L, ...s3R]), TX: 43, RX: 44 },
  analog: s3Analog,
  kinds: { '3V3': 'vout', '3V3b': 'vout', '5V': 'vin', GND: 'gnd', GND2: 'gnd', GND3: 'gnd', GND4: 'gnd', RST: 'in' },
  extra: { '5V': { label: '5V (4.5-5.5 V in)', vmin: 4.5, vmax: 6 }, '3V3b': { label: '3V3' }, RST: { pulled: 'up' }, IO8: { label: 'IO8 (SDA)' }, IO9: { label: 'IO9 (SCL)' }, IO48: { label: 'IO48 (RGB LED)' }, IO0: { label: 'IO0 (BOOT)', pulled: 'up' } },
  look: [[1.8, 0.3, 2.6, '#b9bec7', 0, -1.6], [1.8, 0.04, 0.7, '#1c3d6b', 0, -2.85], [0.8, 0.3, 0.55, '#b9bec7', -0.5, 2.9], [0.8, 0.3, 0.55, '#b9bec7', 0.5, 2.9], [0.35, 0.15, 0.35, '#e9e9e9', -0.75, 2.2], [0.35, 0.15, 0.35, '#e9e9e9', 0.75, 2.2]],
  led: [0.3, 1.7, '#e8e8ff'],
  logicV: 3.3, adc: { bits: 12, vref: 3.3 }, builtinLed: 48, wifi: true,
  i2c: { sda: 'IO8', scl: 'IO9' }, spi: { sck: 'IO12', mosi: 'IO11', miso: 'IO13', ss: 'IO10' },
  defines: { ...ESP32_VERSION, CONFIG_IDF_TARGET_ESP32S3: 1, ARDUINO_ESP32S3_DEV: 1 },
  constants: { SDA: 8, SCL: 9, LED_BUILTIN: 48, RGB_BUILTIN: 48, TX: 43, RX: 44, __RX1: 18, __TX1: 17 },
  shorts: [['GND', 'GND2'], ['GND', 'GND3'], ['GND', 'GND4'], ['3V3', '3V3b']],
  power: { vin: '5V', vinMin: 4.5, usbPin: '5V', out3v3: ['3V3'] },
};
const c3L = ['5V', 'GND', '3V3', 'IO4', 'IO3', 'IO2', 'IO1', 'IO0'];
const c3R = ['IO5', 'IO6', 'IO7', 'IO8', 'IO9', 'IO10', 'IO20', 'IO21'];
export const ESP32C3: BoardDef = {
  id: 'esp32c3-mini', name: 'ESP32-C3 SuperMini (Wi-Fi)', color: '#24262b', w: 1.8, d: 2.25, mass: 2,
  description: 'The tiny ESP32-C3 SuperMini with Wi-Fi: GPIO numbers as printed, analog on 0-4 (0-4095), its blue LED on 8 (lights when LOW), I2C on 8 (SDA) / 9 (SCL), SPI on 4 / 6 / 5 / 7, Serial on 20 (RX) / 21 (TX). WiFi and WebServer as on an ESP32. USB, or 5 V on its 5V pin.',
  rows: [
    { ids: c3L, along: 'z', at: -0.762, start: -((c3L.length - 1) * P) / 2 },
    { ids: c3R, along: 'z', at: 0.762, start: -((c3R.length - 1) * P) / 2 },
  ],
  pins: io([...c3L, ...c3R]),
  analog: ['IO0', 'IO1', 'IO2', 'IO3', 'IO4'],
  kinds: { '3V3': 'vout', '5V': 'vin', GND: 'gnd' },
  extra: { '5V': { label: '5V (4.5-5.5 V in)', vmin: 4.5, vmax: 6 }, IO8: { label: 'IO8 (SDA, its LED)' }, IO9: { label: 'IO9 (SCL, BOOT)', pulled: 'up' }, IO20: { label: 'IO20 (RX)' }, IO21: { label: 'IO21 (TX)' } },
  look: [[0.6, 0.1, 0.6, '#151618', 0, 0.1], [0.8, 0.3, 0.5, '#b9bec7', 0, -0.9], [1.2, 0.05, 0.3, '#1c3d6b', 0, 0.9]],
  led: [0.45, -0.3, '#4f9cff'],
  logicV: 3.3, adc: { bits: 12, vref: 3.3 }, builtinLed: 8, ledActiveLow: true, wifi: true,
  i2c: { sda: 'IO8', scl: 'IO9' }, spi: { sck: 'IO4', mosi: 'IO6', miso: 'IO5', ss: 'IO7' },
  defines: { ...ESP32_VERSION, CONFIG_IDF_TARGET_ESP32C3: 1, ARDUINO_ESP32C3_DEV: 1 },
  constants: { SDA: 8, SCL: 9, LED_BUILTIN: 8, TX: 21, RX: 20 },
  power: { vin: '5V', vinMin: 4.5, usbPin: '5V', out3v3: ['3V3'] },
};

// ------------------------------------------------------------------------------------------ Pico W
// Pin for pin like the Pico W, for Arduino-style sketches (the arduino-pico core): WiFi.h and
// WebServer.h as on an ESP32, WiFi.begin waits until connected, its LED (on the Wi-Fi chip) is
// LED_BUILTIN. (For a real .uf2 build, the RP2040 board runs the chip itself.)
const pwL = ['GP0', 'GP1', 'GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GND2', 'GP6', 'GP7', 'GP8', 'GP9', 'GND3', 'GP10', 'GP11', 'GP12', 'GP13', 'GND4', 'GP14', 'GP15'];
const pwR = ['VBUS', 'VSYS', 'GND5', 'EN', '3V3', 'GP28', 'GND6', 'GP27', 'GP26', 'RUN', 'GP22', 'GND7', 'GP21', 'GP20', 'GP19', 'GP18', 'GND8', 'GP17', 'GP16', 'GND9'];
const pwGnd = [...pwL, ...pwR].filter((p) => p.startsWith('GND'));
export const PICOW: BoardDef = {
  id: 'pico-w', name: 'Pico W (Wi-Fi, sketches)', color: '#2e7d4f', w: 2.1, d: 5.1, mass: 4,
  description: 'A Raspberry Pi Pico W for Arduino-style sketches (the arduino-pico core): GP0-GP28 as printed, analog on GP26-GP28 (A0-A2; 0-1023, analogReadResolution(12) for 0-4095), its LED is LED_BUILTIN (on the Wi-Fi chip), I2C on GP4 (SDA) / GP5 (SCL), SPI on GP18 / GP19 / GP16 / GP17, Serial1 on GP0 / GP1, Serial2 on GP8 / GP9. WiFi.h and WebServer.h as on an ESP32; WiFi.begin waits until connected. USB, or 1.8-5.5 V on VSYS. (To run a real .uf2 instead, use the RP2040 board.)',
  rows: [
    { ids: pwL, along: 'z', at: -2.1 / 2 + 0.15, start: -((pwL.length - 1) * P) / 2 },
    { ids: pwR, along: 'z', at: 2.1 / 2 - 0.15, start: -((pwR.length - 1) * P) / 2 },
  ],
  pins: Object.fromEntries([...pwL, ...pwR].flatMap((id) => (/^GP\d+$/.test(id) ? [[id, Number(id.slice(2))]] : []))),
  analog: ['GP26', 'GP27', 'GP28'],
  kinds: { VBUS: 'vout', VSYS: 'vin', '3V3': 'vout', EN: 'in', RUN: 'in', ...Object.fromEntries(pwGnd.map((g) => [g, 'gnd'])) },
  extra: { VSYS: { label: 'VSYS (1.8-5.5 V in)', vmin: 1.8, vmax: 5.5 }, RUN: { pulled: 'up' }, EN: { label: '3V3_EN', pulled: 'up' }, GP4: { label: 'GP4 (SDA)' }, GP5: { label: 'GP5 (SCL)' }, GP26: { label: 'GP26 (A0)' }, GP27: { label: 'GP27 (A1)' }, GP28: { label: 'GP28 (A2)' } },
  look: [[0.7, 0.1, 0.7, '#151618', 0, 0.2], [0.8, 0.3, 0.55, '#b9bec7', 0, -2.3], [0.5, 0.12, 0.35, '#e9e9e9', 0.5, -1.5], [1.1, 0.2, 1.0, '#b9bec7', 0, 1.6], [1.6, 0.04, 0.5, '#20563a', 0, 2.3]],
  led: [-0.55, -1.9, '#30d158'],
  logicV: 3.3, adc: { bits: 10, vref: 3.3 }, builtinLed: 64, wifi: true, wifiWaits: true,
  i2c: { sda: 'GP4', scl: 'GP5' }, spi: { sck: 'GP18', mosi: 'GP19', miso: 'GP16', ss: 'GP17' },
  defines: { ARDUINO_ARCH_RP2040: 1, ARDUINO_RASPBERRY_PI_PICO_W: 1, PICO_CYW43_SUPPORTED: 1 },
  constants: { SDA: 4, SCL: 5, LED_BUILTIN: 64, A0: 26, A1: 27, A2: 28, __TX1: 0, __RX1: 1, __TX2: 8, __RX2: 9 },
  shorts: pwGnd.slice(1).map((g) => ['GND', g] as [string, string]),
  power: { vin: 'VSYS', vinMin: 1.8, usbPin: 'VBUS', out3v3: ['3V3'] },
};

export const BOARD_DEFS: BoardDef[] = [NANO, MEGA, NODEMCU, D1MINI, ESP32S3, ESP32C3, PICOW];
export const BOARDS: PartType[] = BOARD_DEFS.map((b) => boardPart(b));
