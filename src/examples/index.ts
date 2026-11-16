// Example projects shipped with the app (Examples menu). A program source "@file" is filled in from
// the file of that name here (so sketches stay readable as files).
import obstacleIno from './obstacle-rover.ino?raw';
import espSwitchIno from './esp32-web-switch.ino?raw';
import espSwitch from './esp32-web-switch.bench?raw';
import wifiRoverIno from './wifi-rover.ino?raw';
import wifiRover from './wifi-rover.bench?raw';
import obstacle from './obstacle-rover.bench?raw';
import rover from './rover.bench?raw';
import rp2040Modules from './rp2040-modules.bench?raw';
import servoArm from './servo-arm.bench?raw';
import servoArmIno from './servo-arm.ino?raw';

const FILES: Record<string, string> = { 'obstacle-rover.ino': obstacleIno, 'esp32-web-switch.ino': espSwitchIno, 'wifi-rover.ino': wifiRoverIno, 'servo-arm.ino': servoArmIno };

function withFiles(text: string) {
  const p = JSON.parse(text);
  for (const prog of Object.values<any>(p.programs ?? {}))
    if (typeof prog.source === 'string' && prog.source.startsWith('@')) prog.source = FILES[prog.source.slice(1)] ?? '';
  return JSON.stringify(p);
}

export const EXAMPLES: { name: string; description: string; text: string }[] = [
  { name: 'Obstacle-avoiding rover', description: 'An Arduino sketch drives two motors through a DRV8833 and steers away from the wall using an HC-SR04. Press Run.', text: withFiles(obstacle) },
  { name: 'Two-wheel rover', description: 'Two gear motors, wheels, a ball caster. Run it and drive the motors by hand (one is mirrored: opposite power = straight).', text: rover },
  { name: 'RP2040 and I2C modules', description: 'A real RP2040 program (.uf2) on an emulated chip: it scans its I2C bus, reads the motion sensor and swings the servo through the servo driver. Press Run and open its serial monitor (Program).', text: rp2040Modules },
  { name: 'Wi-Fi remote-control rover', description: 'A two-wheel car driven from a web page: an ESP32 and an L298N motor driver. Press Run, then select the ESP32 in the run panel and press "Open its web page". The sketch lists every wire.', text: withFiles(wifiRover) },
  { name: 'ESP32 web switch', description: 'An ESP32 joins the bench Wi-Fi and serves a web page that switches its LED and shows its knob. Press Run, then select the ESP32 in the run panel and press "Open its web page".', text: withFiles(espSwitch) },
  { name: 'Servo arm', description: 'A servo on a stand lifting a steel weight, steered by a knob through a board. Press Run and drag the knob slider in the run panel. Make the weight bigger (or swap in the small SG90) and see when the servo stalls.', text: withFiles(servoArm) },
];
