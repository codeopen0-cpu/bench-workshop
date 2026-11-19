import RAPIER from '@dimforge/rapier3d-compat';
import { App } from './app';
import { registerKit } from './kit';
import { loadInstalled } from './lib/store';

await RAPIER.init();
registerKit();
await loadInstalled(); // (before the app: the last bench may use library parts)
const app = new App(RAPIER);
// handy for poking at it from the developer console (and for automated checks)
(window as any).bench = app;

// the control API was on last time: on again
try { if (localStorage.getItem('bench.api') === '1') void app.toggleApi(); } catch { /* no storage */ }

// a newer version on GitHub? (desktop app only; a few seconds in, so start-up isn't slowed)
setTimeout(() => import('./update').then((u) => u.checkForUpdate((m, l) => app.log(m, l))), 4000);

// newer versions of installed libraries on the list? (say so; installing stays the user's choice)
setTimeout(async () => {
  try {
    const { fetchRegistry, installed, newer } = await import('./lib/store');
    if (!installed.size) return;
    const list = await fetchRegistry();
    const ups = list.filter((e) => installed.has(e.id) && newer(e.version, installed.get(e.id)!.version));
    console.info(`[library] updates: ${ups.map((e) => `${e.id} ${installed.get(e.id)!.version} -> ${e.version}`).join(', ') || 'none'}`);
    if (ups.length) app.log(`Library update${ups.length > 1 ? 's' : ''}: ${ups.map((e) => `${e.name} ${e.version}`).join(', ')}. Get ${ups.length > 1 ? 'them' : 'it'} in Libraries > Browse.`, 'warn');
  } catch (e) {
    console.warn(`[library] couldn't check for library updates: ${(e as Error).message}`);
  }
}, 6000);
