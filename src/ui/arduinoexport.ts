// "Save for Arduino IDE": a board's program as a sketch folder the Arduino IDE opens and compiles on
// the first try: <name>/<name>.ino, and a README.txt that says which board to pick, its Boards
// Manager address, every library the sketch #includes (by its Library Manager name, with what it
// needs too, and arduino-cli commands for all of it), how the board is wired on the bench, and what
// the circuit check found about its pins on a real board. MicroPython programs: main.py and how to
// put it on the board (Thonny).
import type { Issue } from '../elec/check';
import type { Project } from '../project';
import type { PartView } from '../views';
import { BOARD_FQBN, CHOICES, CORES } from './realboard';

/** A header the sketch includes -> the Arduino library that has it (Library Manager name), what that
 *  library needs installed too, and a note. null: built into the board's core (nothing to install). */
const LIBS: Record<string, { lib: string; deps?: string[]; note?: string } | null> = {
  'Arduino.h': null, 'Wire.h': null, 'SPI.h': null, 'EEPROM.h': null, 'SoftwareSerial.h': null, 'HardwareSerial.h': null,
  'WiFi.h': null, 'WebServer.h': null, 'ESPmDNS.h': null, 'WiFiClient.h': null, 'WiFiServer.h': null, 'Preferences.h': null,
  'esp_now.h': null, 'esp_wifi.h': null, 'BluetoothSerial.h': null, 'ESP8266WiFi.h': null, 'ESP8266WebServer.h': null, 'ESP8266mDNS.h': null,
  'WiFiS3.h': null, 'SD.h': null, 'Stepper.h': null, 'LiquidCrystal.h': null, 'math.h': null, 'stdint.h': null, 'stdio.h': null, 'stdlib.h': null, 'string.h': null,
  'Servo.h': { lib: 'Servo', note: 'built into Arduino AVR / RP2040; on an ESP32 use ESP32Servo instead' },
  'ESP32Servo.h': { lib: 'ESP32Servo' },
  'WiFiNINA.h': { lib: 'WiFiNINA' }, 'WiFi101.h': { lib: 'WiFi101' },
  'AccelStepper.h': { lib: 'AccelStepper' },
  'Adafruit_BME280.h': { lib: 'Adafruit BME280 Library', deps: ['Adafruit Unified Sensor', 'Adafruit BusIO'] },
  'Adafruit_GFX.h': { lib: 'Adafruit GFX Library', deps: ['Adafruit BusIO'] },
  'Adafruit_MPU6050.h': { lib: 'Adafruit MPU6050', deps: ['Adafruit Unified Sensor', 'Adafruit BusIO'] },
  'Adafruit_NeoPixel.h': { lib: 'Adafruit NeoPixel' },
  'Adafruit_SSD1306.h': { lib: 'Adafruit SSD1306', deps: ['Adafruit GFX Library', 'Adafruit BusIO'] },
  'Adafruit_ST7735.h': { lib: 'Adafruit ST7735 and ST7789 Library', deps: ['Adafruit GFX Library', 'Adafruit BusIO'] },
  'Adafruit_TCS34725.h': { lib: 'Adafruit TCS34725', deps: ['Adafruit BusIO'] },
  'Adafruit_VL53L0X.h': { lib: 'Adafruit_VL53L0X', deps: ['Adafruit BusIO'] },
  'Adafruit_AMG88xx.h': { lib: 'Adafruit AMG88xx Library', deps: ['Adafruit BusIO'] },
  'ArduCAM.h': { lib: 'ArduCAM', note: 'in its memorysaver.h leave only your module on (Mini 2MP: #define OV2640_MINI_2MP)' },
  'memorysaver.h': null,
  'BH1750.h': { lib: 'BH1750' },
  'DFRobotDFPlayerMini.h': { lib: 'DFRobotDFPlayerMini' },
  'DHT.h': { lib: 'DHT sensor library', deps: ['Adafruit Unified Sensor'] },
  'Dynamixel2Arduino.h': { lib: 'Dynamixel2Arduino' },
  'HX711.h': { lib: 'HX711 Arduino Library' },
  'IRremote.h': { lib: 'IRremote' }, 'IRremote.hpp': { lib: 'IRremote' },
  'Keypad.h': { lib: 'Keypad' },
  'LedControl.h': { lib: 'LedControl' },
  'LiquidCrystal_I2C.h': { lib: 'LiquidCrystal I2C' },
  'LoRa.h': { lib: 'LoRa' },
  'MFRC522.h': { lib: 'MFRC522' },
  'PS2X_lib.h': { lib: 'PS2X_lib', note: 'not in the Library Manager: download it from github.com/madsci1016/Arduino-PS2X and add it with Sketch > Include Library > Add .ZIP Library' },
  'RF24.h': { lib: 'RF24' }, 'nRF24L01.h': { lib: 'RF24' },
  'RTClib.h': { lib: 'RTClib', deps: ['Adafruit BusIO'] },
  'SCServo.h': { lib: 'SCServo', note: "Feetech's library: if the Library Manager doesn't have it, it's at github.com/workloads/scservo-arduino" },
  'TM1637Display.h': { lib: 'TM1637' },
  'TinyGPSPlus.h': { lib: 'TinyGPSPlus' }, 'TinyGPS++.h': { lib: 'TinyGPSPlus' },
  'VL53L0X.h': { lib: 'VL53L0X', note: "Pololu's" },
  'mcp_can.h': { lib: 'mcp_can', note: "coryjfowler's MCP_CAN library" },
  'QMC5883LCompass.h': { lib: 'QMC5883LCompass' },
  'Bitcraze_PMW3901.h': { lib: 'Bitcraze PMW3901' },
  'MPU6050_light.h': { lib: 'MPU6050_light' },
  'RPLidar.h': { lib: 'RPLidar', note: "Slamtec's: github.com/robopeak/rplidar_arduino" },
  'BlobCam.h': { lib: '(bench only)', note: 'the bench\'s simulated colour camera: a real build needs a real one (an OpenMV, a Pixy2 or an ESP32-CAM) and its own library, so this part of the sketch has to change' },
};

export interface ExportedFile { path: string; text: string }

export function sketchFiles(project: Project, views: Map<string, PartView>, uid: string, issues: Issue[]): { folder: string; files: ExportedFile[]; libs: string[] } {
  const v = views.get(uid);
  const prog = project.programs[uid];
  if (!v || !prog) throw new Error('no program on that board');
  const folder = (v.inst.name || project.name || 'sketch').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').slice(0, 40) || 'sketch';
  const fqbn = BOARD_FQBN[v.inst.type];
  const coreId = fqbn?.split(':').slice(0, 2).join(':');
  const core = coreId ? CORES[coreId] : undefined;
  const lines: string[] = [];
  const say = (s = '') => lines.push(s);
  say(`${v.inst.name} (${v.type.name}): ${prog.lang === 'python' ? 'MicroPython program' : 'Arduino sketch'} from Bench Workshop`);
  say(`Bench: ${project.name}. Saved ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.`);
  say('');
  const libs: string[] = [];
  if (prog.lang === 'python') {
    say('PUT IT ON THE BOARD');
    say('  1. Put MicroPython on the board (hold BOOTSEL, plug it in, copy the MicroPython .uf2 for your board from micropython.org onto the drive that appears).');
    say('  2. Open main.py in Thonny (thonny.org), pick "MicroPython (Raspberry Pi Pico)" at the bottom right, then File > Save as > Raspberry Pi Pico > main.py.');
    say('  It runs every time the board powers up.');
  } else {
    say('THE BOARD');
    if (fqbn) {
      say(`  In the Arduino IDE: Tools > Board > ${core?.name ?? coreId} > ${CHOICES.find(([f]) => f === fqbn)?.[1] ?? fqbn.split(':')[2]} (${fqbn}).`);
      if (core?.url) say(`  If that board isn't listed: File > Preferences > Additional boards manager URLs, add\n    ${core.url}\n  then Tools > Board > Boards Manager, search "${coreId!.split(':')[0]}", Install (${core.size}).`);
      else if (core) say(`  If it isn't listed: Tools > Board > Boards Manager, search "${coreId}", Install (${core.size}).`);
    } else say(`  ${v.type.name}: pick the board you have under Tools > Board.`);
    say('');
    // the libraries it includes
    const code = prog.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const includes = [...new Set([...code.matchAll(/#include\s*[<"]([^>"]+)[>"]/g)].map((m) => m[1]))];
    const need = new Map<string, string[]>(); // library -> notes
    const unknown: string[] = [];
    for (const h of includes) {
      const e = LIBS[h];
      if (e === null) continue;
      if (!e) { unknown.push(h); continue; }
      if (h === 'Servo.h' && v.inst.type.startsWith('esp32')) {
        need.set('ESP32Servo', ['an ESP32 has no built-in Servo: change #include <Servo.h> to #include <ESP32Servo.h> (the rest stays the same)']);
        continue;
      }
      if (h === 'Servo.h') continue; // (built into the AVR, RP2040, R4 and ESP8266 cores)
      need.set(e.lib, [...(need.get(e.lib) ?? []), ...(e.note ? [e.note] : [])]);
      for (const d of e.deps ?? []) if (!need.has(d)) need.set(d, [`needed by ${e.lib}`]);
    }
    say('LIBRARIES (Sketch > Include Library > Manage Libraries, search each name, Install)');
    if (!need.size && !unknown.length) say('  None to install: everything it includes comes with the board.');
    for (const [lib, notes] of need) {
      say(`  - ${lib}${notes.length ? `: ${[...new Set(notes)].join('; ')}` : ''}`);
      if (lib !== '(bench only)') libs.push(lib);
    }
    for (const h of unknown) say(`  - ${h}: look for the library that has it in the Library Manager (search its name).`);
    if (fqbn || libs.length) {
      say('');
      say('OR WITH ARDUINO-CLI (in this folder)');
      if (core?.url) say(`  arduino-cli core install ${coreId} --additional-urls ${core.url}`);
      else if (coreId) say(`  arduino-cli core install ${coreId}`);
      for (const l of libs) say(`  arduino-cli lib install "${l}"`);
      if (fqbn) say(`  arduino-cli compile --fqbn ${fqbn} .\n  arduino-cli upload --fqbn ${fqbn} -p <your port, e.g. COM5 or /dev/ttyUSB0> .`);
    }
  }
  // how it's wired on the bench: each of the board's pins and everything on the same connection
  say('');
  say('WIRING (as on the bench)');
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k);
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  for (const w of project.wires) parent.set(find(`${w.a.uid}/${w.a.pin}`), find(`${w.b.uid}/${w.b.pin}`));
  const pinName = (key: string) => {
    const [u, ...rest] = key.split('/');
    const pin = rest.join('/');
    const pv = views.get(u);
    const def = pv?.build.pins?.find((p) => p.id === pin);
    return `${pv?.inst.name ?? u} ${def?.label ?? pin}`;
  };
  const all = [...new Set(project.wires.flatMap((w) => [`${w.a.uid}/${w.a.pin}`, `${w.b.uid}/${w.b.pin}`]))];
  let any = false;
  for (const p of v.build.pins ?? []) {
    const k = `${uid}/${p.id}`;
    if (!all.includes(k)) continue;
    const others = all.filter((o) => o !== k && find(o) === find(k) && !o.startsWith(`${uid}/`));
    if (!others.length) continue;
    any = true;
    say(`  ${p.label ?? p.id}  ->  ${others.map(pinName).join(', ')}`);
  }
  if (!any) say('  (nothing is wired to it)');
  // what the check says about it on a real board
  const mine = issues.filter((i) => i.parts.includes(uid));
  if (mine.length) {
    say('');
    say('BEFORE YOU BUILD IT (the bench\'s circuit check)');
    for (const i of mine) say(`  ${i.level === 'fault' ? 'PROBLEM' : 'check'}: ${i.what}`);
  }
  const files: ExportedFile[] = prog.lang === 'python'
    ? [{ path: 'main.py', text: prog.source }]
    : [{ path: `${folder}.ino`, text: prog.source }];
  files.push({ path: 'README.txt', text: lines.join('\n') + '\n' });
  return { folder, files, libs };
}

/** Save the sketch folder: pick where (the desktop app), or download its files (a browser). */
export async function saveForIde(project: Project, views: Map<string, PartView>, uid: string, issues: Issue[], log: (m: string, l?: 'info' | 'warn' | 'bad') => void) {
  const { folder, files, libs } = sketchFiles(project, views, uid, issues);
  if ('__TAURI_INTERNALS__' in window) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { mkdir, writeTextFile, exists } = await import('@tauri-apps/plugin-fs');
    const where = await open({ directory: true, recursive: true, title: `Where to put the "${folder}" sketch folder` });
    if (!where || Array.isArray(where)) return null;
    const sep = where.includes('\\') ? '\\' : '/';
    const dir = `${where}${where.endsWith(sep) ? '' : sep}${folder}`;
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    for (const f of files) await writeTextFile(`${dir}${sep}${f.path}`, f.text);
    console.info(`[export] ${files.length} files in ${dir}; libraries: ${libs.join(', ') || 'none'}`);
    log(`saved for the Arduino IDE: ${dir} (${files.map((f) => f.path).join(', ')}). README.txt says which board to pick and which libraries to install${libs.length ? ` (${libs.join(', ')})` : ''}.`);
    return dir;
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([f.text], { type: 'text/plain' }));
    a.download = f.path;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  console.info(`[export] downloaded ${files.map((f) => f.path).join(', ')} (put them in a folder called ${folder})`);
  log(`downloaded ${files.map((f) => f.path).join(' and ')}: put them in a folder called "${folder}" and open the .ino in the Arduino IDE`);
  return folder;
}
