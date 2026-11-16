// Updates: the desktop app checks GitHub (codeopen0-cpu/bench-workshop, latest release) when it
// starts. A newer version is offered, downloaded, checked against the app's signing key (an update
// not signed by its maker is refused), installed, and the app restarts into it.
import { getVersion } from '@tauri-apps/api/app';

const inTauri = () => '__TAURI_INTERNALS__' in window;

export async function checkForUpdate(log: (m: string, l?: 'info' | 'warn' | 'bad') => void, quiet = true) {
  if (!inTauri()) return;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const current = await getVersion();
    const update = await check();
    if (!update) {
      console.info(`[update] ${current} is the newest`);
      if (!quiet) log(`Bench Workshop ${current} is the newest version`);
      return;
    }
    console.info(`[update] ${update.version} is out (this is ${current})`);
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const yes = await ask(`Bench Workshop ${update.version} is out (you have ${current}).${update.body ? `\n\n${update.body}` : ''}\n\nInstall it now? The app restarts (save your bench first).`, { title: 'Update', kind: 'info', okLabel: 'Install', cancelLabel: 'Later' });
    if (!yes) return;
    let got = 0, total = 0;
    log(`downloading Bench Workshop ${update.version}...`);
    await update.downloadAndInstall((e) => {
      if (e.event === 'Started') total = e.data.contentLength ?? 0;
      else if (e.event === 'Progress') got += e.data.chunkLength;
      else if (e.event === 'Finished') console.info(`[update] downloaded ${got} of ${total} bytes, installing`);
    });
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    console.warn(`[update] check failed: ${(e as Error)?.message ?? e}`);
    if (!quiet) log(`couldn't check for updates: ${(e as Error)?.message ?? e}`, 'warn');
  }
}
