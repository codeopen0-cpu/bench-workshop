// A library straight from its folder (library.json + device.js + sketch/*.js + models + examples),
// for making one: edit a file, press Reload, test again. The same steps as the list's pack tool
// (registry/tools/pack.mjs), and the same safety check when it's installed.

/** the folder's files, by path inside it ("library.json", "sketch/Foo.js"...) */
export type FolderFiles = Map<string, Uint8Array>;

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

export function libraryFromFolder(files: FolderFiles): any {
  const get = (p: string) => {
    const k = p.replace(/^\.\//, '').replace(/\\/g, '/');
    const f = files.get(k);
    if (!f) throw new Error(`${k} is missing from the folder`);
    return f;
  };
  const lib = JSON.parse(text(get('library.json')));
  if (typeof lib.code === 'string' && /\.js$/.test(lib.code)) lib.code = text(get(lib.code));
  for (const f of Object.values<any>(lib.sketch ?? {}))
    if (f?.file) {
      f.code = text(get(f.file));
      delete f.file;
    }
  for (const p of lib.parts ?? [])
    if (p?.glbFile) {
      p.glb = b64(get(p.glbFile));
      delete p.glbFile;
    }
  for (const ex of lib.examples ?? [])
    if (ex?.file) {
      ex.project = JSON.parse(text(get(ex.file)));
      delete ex.file;
    }
  return lib;
}

const inTauri = () => '__TAURI_INTERNALS__' in window;

/** Pick a library folder and read it. In the desktop app the folder is remembered (for Reload). */
export async function pickLibraryFolder(): Promise<{ files: FolderFiles; path: string | null } | null> {
  if (inTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ directory: true, recursive: true, title: 'A library folder (with library.json in it)' });
    if (!path || Array.isArray(path)) return null;
    return { files: await readFolder(String(path)), path: String(path) };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as any).webkitdirectory = true;
    input.onchange = async () => {
      const files: FolderFiles = new Map();
      for (const f of Array.from(input.files ?? [])) {
        const rel = ((f as any).webkitRelativePath as string).split('/').slice(1).join('/'); // (drop the folder's own name)
        files.set(rel, new Uint8Array(await f.arrayBuffer()));
      }
      resolve(files.size ? { files, path: null } : null);
    };
    input.click();
  });
}

/** Read a folder again (desktop app). */
export async function readFolder(path: string): Promise<FolderFiles> {
  const fs = await import('@tauri-apps/plugin-fs');
  const files: FolderFiles = new Map();
  const walk = async (dir: string, rel: string) => {
    for (const e of await fs.readDir(dir)) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = `${dir}/${e.name}`, r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(full, r);
      else if (e.isFile) files.set(r, await fs.readFile(full));
    }
  };
  await walk(path.replace(/\\/g, '/'), '');
  return files;
}

// where each library being worked on came from (desktop app), for Reload
const KEY = 'bench.libraryFolders';
export function folderOf(id: string): string | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}')[id] ?? null; } catch { return null; }
}
export function rememberFolder(id: string, path: string | null) {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (path) m[id] = path;
    else delete m[id];
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch { /* not remembered */ }
}
