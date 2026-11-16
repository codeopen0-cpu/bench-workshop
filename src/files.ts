// Save / open project files. In the desktop app: the system's file dialogs (Tauri). In a plain
// browser (development): download / upload.
export const inTauri = () => '__TAURI_INTERNALS__' in window;

const FILTERS = [{ name: 'Bench Workshop project', extensions: ['bench'] }];

export async function saveText(suggested: string, text: string): Promise<string | null> {
  if (inTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: suggested, filters: FILTERS });
    if (!path) return null;
    await writeTextFile(path, text);
    return path;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = suggested;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return suggested;
}

/** Pick a binary file (firmware .uf2, 3D model .glb...). */
export async function openBinary(extensions: string[], label = 'File'): Promise<{ name: string; bytes: Uint8Array } | null> {
  if (inTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({ multiple: false, filters: [{ name: label, extensions }] });
    if (!path || Array.isArray(path)) return null;
    return { name: String(path), bytes: await readFile(String(path)) };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.map((e) => '.' + e).join(',');
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null);
    };
    input.click();
  });
}

export async function openText(extensions = ['bench', 'json'], label = 'Bench Workshop project'): Promise<{ name: string; text: string } | null> {
  if (!(extensions.length === 2 && extensions[0] === 'bench')) {
    const f = await openBinary(extensions, label);
    return f ? { name: f.name, text: new TextDecoder().decode(f.bytes) } : null;
  }
  if (inTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({ multiple: false, filters: FILTERS });
    if (!path || Array.isArray(path)) return null;
    return { name: String(path), text: await readTextFile(String(path)) };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bench,.json';
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.click();
  });
}
