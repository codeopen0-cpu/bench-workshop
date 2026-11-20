// Updates: the desktop app checks GitHub (codeopen0-cpu/bench-workshop, latest release) when it
// starts. A newer version is offered, downloaded, checked against the app's signing key (an update
// not signed by its maker is refused), installed, and the app restarts into it.
// Linux builds (made on GitHub, .deb and AppImage) don't install updates themselves: there the app
// looks at the latest release and offers its download page.
import { getVersion } from '@tauri-apps/api/app';

const inTauri = () => '__TAURI_INTERNALS__' in window;
const REPO = 'codeopen0-cpu/bench-workshop';
const isLinux = () => /linux/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent);

/** a.b.c newer than x.y.z */
const newer = (a: string, b: string) => {
  const p = (s: string) => s.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** Linux: the latest release's version, and its page to download from */
async function checkByReleasePage(current: string, log: (m: string, l?: 'info' | 'warn' | 'bad') => void, quiet: boolean) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const rel = await r.json();
  const latest = String(rel.tag_name ?? '').replace(/^v/, '');
  const hasLinux = (rel.assets ?? []).some((a: any) => /\.(deb|AppImage)$/.test(a.name));
  console.info(`[update] Linux: latest release ${latest || '?'} (${hasLinux ? 'with' : 'without'} Linux files yet), this is ${current}`);
  if (!latest || !newer(latest, current) || !hasLinux) {
    if (!quiet) log(`Bench Workshop ${current} is the newest version${latest && newer(latest, current) ? ` for Linux (${latest} is still being built for it)` : ''}`);
    return;
  }
  const { ask } = await import('@tauri-apps/plugin-dialog');
  const yes = await ask(`Bench Workshop ${latest} is out (you have ${current}).${rel.body ? `\n\n${rel.body}` : ''}\n\nOpen its download page? (On Linux, install the new .deb or AppImage from there.)`, { title: 'Update', kind: 'info', okLabel: 'Open the page', cancelLabel: 'Later' });
  if (!yes) return;
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(String(rel.html_url ?? `https://github.com/${REPO}/releases/latest`));
}

export async function checkForUpdate(log: (m: string, l?: 'info' | 'warn' | 'bad') => void, quiet = true) {
  if (!inTauri()) return;
  let current = '?';
  try {
    current = await getVersion();
    if (isLinux()) return await checkByReleasePage(current, log, quiet);
    const { check } = await import('@tauri-apps/plugin-updater');
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
