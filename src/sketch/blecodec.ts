// Bluetooth LE values as bytes, the way ArduinoBLE's typed characteristics store them (little-endian,
// the sizes an ARM or ESP32 board uses: int and long 4 bytes, double 8). Shared by the program side
// (sketch/worker.ts) and the bench's "phone" (elec/devices.ts).
export type BleKind = 'bool' | 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'f32' | 'f64' | 'string' | 'bytes';

export const BLE_SIZE: Record<string, number> = { bool: 1, i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4, f64: 8 };

export const BLE_PROPS = {
  BLEBroadcast: 0x01, BLERead: 0x02, BLEWriteWithoutResponse: 0x04, BLEWrite: 0x08, BLENotify: 0x10, BLEIndicate: 0x20,
  BLEAuthSignedWrite: 0x40, BLEExtProp: 0x80, BLEEncryption: 1 << 9, BLEAuthentication: 1 << 10, BLEAuthorization: 1 << 11,
};

const utf8 = new TextEncoder(), text = new TextDecoder();

export function bleEncode(kind: BleKind, v: any): number[] {
  if (kind === 'string') return Array.from(utf8.encode(String(v ?? '')));
  if (kind === 'bytes') {
    if (typeof v === 'string') return Array.from(utf8.encode(v));
    if (v && typeof v === 'object' && typeof v.length === 'number') return Array.from(v as ArrayLike<number>, (x) => Number(x) & 255);
    return [Number(v) & 255];
  }
  const d = new DataView(new ArrayBuffer(8));
  const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v) || 0;
  switch (kind) {
    case 'bool': d.setUint8(0, n ? 1 : 0); break;
    case 'i8': d.setInt8(0, n); break;
    case 'u8': d.setUint8(0, n & 255); break;
    case 'i16': d.setInt16(0, n, true); break;
    case 'u16': d.setUint16(0, n & 0xffff, true); break;
    case 'i32': d.setInt32(0, n | 0, true); break;
    case 'u32': d.setUint32(0, n >>> 0, true); break;
    case 'f32': d.setFloat32(0, n, true); break;
    case 'f64': d.setFloat64(0, n, true); break;
  }
  return Array.from(new Uint8Array(d.buffer, 0, BLE_SIZE[kind]));
}

export function bleDecode(kind: BleKind, bytes: number[]): any {
  if (kind === 'string') return text.decode(new Uint8Array(bytes));
  if (kind === 'bytes') return bytes.slice();
  const b = new Uint8Array(8);
  b.set(bytes.slice(0, 8));
  const d = new DataView(b.buffer);
  switch (kind) {
    case 'bool': return b[0] !== 0;
    case 'i8': return d.getInt8(0);
    case 'u8': return d.getUint8(0);
    case 'i16': return d.getInt16(0, true);
    case 'u16': return d.getUint16(0, true);
    case 'i32': return d.getInt32(0, true);
    case 'u32': return d.getUint32(0, true);
    case 'f32': return d.getFloat32(0, true);
    case 'f64': return d.getFloat64(0, true);
  }
  return 0;
}

/** what a phone app shows for a value */
export function bleShow(kind: BleKind, bytes: number[]): string {
  if (kind === 'bytes') return bytes.length ? bytes.map((x) => x.toString(16).padStart(2, '0')).join(' ') : '(empty)';
  if (kind === 'string') return JSON.stringify(bleDecode(kind, bytes));
  const v = bleDecode(kind, bytes);
  return kind === 'f32' || kind === 'f64' ? String(Math.round(v * 1000) / 1000) : String(v);
}

/** what you typed into the phone, as bytes for that value: a number, true / false, text, or hex bytes ("01 ff") */
export function bleParse(kind: BleKind, typed: string): number[] {
  const t = typed.trim();
  if (kind === 'string') return bleEncode('string', typed);
  if (kind === 'bytes') return /^([0-9a-f]{2}[\s,:]*)+$/i.test(t) ? (t.match(/[0-9a-f]{2}/gi) ?? []).map((h) => parseInt(h, 16)) : bleEncode('bytes', typed);
  if (kind === 'bool') return bleEncode('bool', /^(1|true|on|yes)$/i.test(t));
  return bleEncode(kind, /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : Number(t));
}

export const bleKindName: Record<BleKind, string> = {
  bool: 'true/false', i8: 'number', u8: 'byte', i16: 'number', u16: 'number', i32: 'number', u32: 'number', f32: 'decimal', f64: 'decimal', string: 'text', bytes: 'bytes',
};
