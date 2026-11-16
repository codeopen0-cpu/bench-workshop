// Parts whose behaviour lives outside the catalog's own imports (so they can use the device helpers
// without an import loop): the breakout modules and the RP2040 board.
import { DEVICE_MAKERS } from '../elec/devices';
import { MODULE_DEVICES } from '../elec/modules';
import { POWER_DEVICES } from '../elec/power';
import { registerParts } from '../parts/catalog';
import { MODULES } from '../parts/modules';

export function registerKit() {
  registerParts(MODULES);
  Object.assign(DEVICE_MAKERS, MODULE_DEVICES, POWER_DEVICES);
  console.info(`[kit] ${MODULES.length} modules registered`);
}
