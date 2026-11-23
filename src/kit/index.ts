// Parts whose behaviour lives outside the catalog's own imports (so they can use the device helpers
// without an import loop): the breakout modules and the RP2040 board.
import { DEVICE_MAKERS } from '../elec/devices';
import { MODULE_DEVICES } from '../elec/modules';
import { POWER_DEVICES } from '../elec/power';
import { registerParts } from '../parts/catalog';
import { MODULES } from '../parts/modules';
import { BOARDS } from '../parts/boards';
import { BOARD_DEVICES } from '../elec/boards';
import { MECHANICS } from '../parts/mechanics';
import { AERO } from '../parts/aero';
import { COURSES } from '../parts/courses';
import { escDevice } from '../elec/aero';
import { SENSORS } from '../parts/sensors';
import { acs712Device, amg8833Device, rplidarDevice, voltageSensorDevice, warmObjectDevice } from '../elec/sensors';
import { motorDevice } from '../elec/devices';
import { AUDIO } from '../parts/audio';
import { i2sAmpDevice, speakerDevice } from '../elec/audio';

export function registerKit() {
  registerParts(MODULES);
  registerParts(BOARDS);
  registerParts(MECHANICS);
  registerParts(AERO);
  registerParts(COURSES);
  registerParts(SENSORS);
  registerParts(AUDIO);
  Object.assign(DEVICE_MAKERS, { 'i2s-amp': (v: Parameters<typeof i2sAmpDevice>[0]) => i2sAmpDevice(v), speaker: (v: Parameters<typeof speakerDevice>[0]) => speakerDevice(v) });
  Object.assign(DEVICE_MAKERS, MODULE_DEVICES, POWER_DEVICES, BOARD_DEVICES, { 'tank-track': (v: Parameters<typeof motorDevice>[0]) => motorDevice(v), esc: (v: Parameters<typeof escDevice>[0]) => escDevice(v), acs712: (v: Parameters<typeof acs712Device>[0]) => acs712Device(v), 'voltage-sensor': (v: Parameters<typeof voltageSensorDevice>[0]) => voltageSensorDevice(v),
    amg8833: (v: Parameters<typeof amg8833Device>[0]) => amg8833Device(v), 'rplidar-a1': (v: Parameters<typeof rplidarDevice>[0]) => rplidarDevice(v), 'warm-object': (v: Parameters<typeof warmObjectDevice>[0]) => warmObjectDevice(v) });
  console.info(`[kit] ${MODULES.length} modules and ${BOARDS.length} more boards registered`);
}
