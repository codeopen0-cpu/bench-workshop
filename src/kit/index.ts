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
import { motorDevice } from '../elec/devices';

export function registerKit() {
  registerParts(MODULES);
  registerParts(BOARDS);
  registerParts(MECHANICS);
  Object.assign(DEVICE_MAKERS, MODULE_DEVICES, POWER_DEVICES, BOARD_DEVICES, { 'tank-track': (v: Parameters<typeof motorDevice>[0]) => motorDevice(v) });
  console.info(`[kit] ${MODULES.length} modules and ${BOARDS.length} more boards registered`);
}
