// Installed libraries: kept in the app's own storage (IndexedDB), added to the parts bin at start-up,
// fetched from a library list (the registry: an index.json anyone can add their library to), or
// installed from a .benchlib file someone shared.
import { DEVICE_MAKERS, sketchLibraries } from '../elec/devices';
import { PART_BY_ID, registerParts, unregisterParts } from '../parts/catalog';
import type { Project } from '../project';
import { checkLibrary, libPartId, libPartType, type Library } from './format';
import { libraryDevice } from './runtime';
import { checkLibrarySafety, safetyReport } from '../../registry/tools/safety.mjs';

/** The safety check of a library file (see registry/tools/safety.mjs): blocked = never installed. */
export const safetyOf = (raw: any) => checkLibrarySafety(raw, JSON.stringify(raw ?? null).length);
export { safetyReport };

/** Where the shared library list lives. Anyone adds a library by adding it there (see registry/README.md). */
export const DEFAULT_REGISTRY = import.meta.env.DEV ? '/registry/index.json' : 'https://raw.githubusercontent.com/codeopen0-cpu/bench-workshop-libraries/main/index.json';
const REGISTRY_KEY = 'bench.registry';

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  category?: string;
  url: string; // the .benchlib, relative to the index
  parts?: string[];
  /** what its parts can do that you'd want to know first: "move", "make sounds"... */
  can?: string[];
  needsApp?: string;
}

export const installed = new Map<string, Library>();
let changed: () => void = () => {};
export const onLibrariesChanged = (fn: () => void) => (changed = fn);

// ------------------------------------------------------------------------------------------ storage
// In the desktop app: one .benchlib file per library in Documents/Bench Workshop/libraries (you can
// see them there, drop a .benchlib in by hand, or delete one). In a plain browser (development): the
// browser's own storage (IndexedDB).
const FOLDER = 'Bench Workshop/libraries';
const inTauri = () => '__TAURI_INTERNALS__' in window;

interface LibStorage {
  where(): Promise<string>;
  list(): Promise<{ name: string; raw: any }[]>;
  put(lib: Library): Promise<void>;
  del(id: string): Promise<void>;
  open?(): Promise<void>;
}

const folderStorage: LibStorage = {
  async where() {
    const { documentDir, join } = await import('@tauri-apps/api/path');
    return join(await documentDir(), 'Bench Workshop', 'libraries');
  },
  async list() {
    const fs = await import('@tauri-apps/plugin-fs');
    const base = { baseDir: fs.BaseDirectory.Document };
    if (!(await fs.exists(FOLDER, base))) await fs.mkdir(FOLDER, { ...base, recursive: true });
    const out: { name: string; raw: any }[] = [];
    for (const e of await fs.readDir(FOLDER, base)) {
      if (!e.isFile || !/\.benchlib$/i.test(e.name)) continue;
      try {
        out.push({ name: e.name, raw: JSON.parse(await fs.readTextFile(`${FOLDER}/${e.name}`, base)) });
      } catch (err) {
        console.warn(`[library] ${e.name} isn't readable: ${(err as Error).message}`);
      }
    }
    return out;
  },
  async put(lib) {
    const fs = await import('@tauri-apps/plugin-fs');
    const base = { baseDir: fs.BaseDirectory.Document };
    if (!(await fs.exists(FOLDER, base))) await fs.mkdir(FOLDER, { ...base, recursive: true });
    await fs.writeTextFile(`${FOLDER}/${lib.id}.benchlib`, JSON.stringify(lib), base);
  },
  async del(id) {
    const fs = await import('@tauri-apps/plugin-fs');
    const base = { baseDir: fs.BaseDirectory.Document };
    // (a library dropped in by hand may have another file name: remove whichever holds this id)
    for (const e of await fs.readDir(FOLDER, base)) {
      if (!e.isFile || !/\.benchlib$/i.test(e.name)) continue;
      if (e.name === `${id}.benchlib`) { await fs.remove(`${FOLDER}/${e.name}`, base); continue; }
      try {
        if (JSON.parse(await fs.readTextFile(`${FOLDER}/${e.name}`, base))?.id === id) await fs.remove(`${FOLDER}/${e.name}`, base);
      } catch { /* not a library */ }
    }
  },
  async open() {
    const { openPath } = await import('@tauri-apps/plugin-opener');
    await openPath(await this.where());
  },
};

const DB = 'bench-workshop', STORE = 'libraries';
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const browserStorage: LibStorage = {
  where: async () => "this browser's storage",
  list: async () => ((await idb<any[]>('readonly', (s) => s.getAll())) ?? []).map((raw) => ({ name: raw?.id ?? '?', raw })),
  put: async (lib) => void (await idb('readwrite', (s) => s.put(lib, lib.id))),
  del: async (id) => void (await idb('readwrite', (s) => s.delete(id))),
};
const storage = (): LibStorage => (inTauri() ? folderStorage : browserStorage);
/** Where installed libraries are kept (a folder path in the desktop app). */
export const librariesWhere = () => storage().where();
export const canOpenFolder = () => !!storage().open;
export const openLibrariesFolder = () => storage().open?.();

// ------------------------------------------------------------------------------------------ in the app
function addToApp(lib: Library) {
  const types = lib.parts.map((p) => libPartType(lib, p));
  registerParts(types);
  for (const p of lib.parts) {
    const id = libPartId(lib, p);
    DEVICE_MAKERS[id] = (v, hooks) => libraryDevice(v, lib, p, hooks);
  }
  installed.set(lib.id, lib);
}
function removeFromApp(lib: Library) {
  const ids = lib.parts.map((p) => libPartId(lib, p));
  unregisterParts(ids);
  for (const id of ids) delete DEVICE_MAKERS[id];
  installed.delete(lib.id);
}

/** At start-up: every installed library back into the parts bin. */
export async function loadInstalled() {
  try {
    for (const lib of [...installed.values()]) removeFromApp(lib); // (a rescan starts clean)
    for (const { name, raw } of await storage().list()) {
      const { lib, problems } = checkLibrary(raw);
      if (!lib) {
        console.warn(`[library] ${name} didn't load: ${problems.join('; ')}`);
        continue;
      }
      const safe = safetyOf(raw);
      if (!safe.ok) {
        console.warn(`[library] ${name} was NOT loaded, the safety check blocked it:\n${safetyReport(safe).join('\n')}`);
        continue;
      }
      try {
        addToApp(lib);
      } catch (e) {
        console.warn(`[library] ${name}: its parts didn't build: ${(e as Error).message}`);
      }
    }
    console.info(`[library] ${installed.size} libraries in ${await storage().where()}: ${[...installed.values()].map((l) => `${l.id} ${l.version}`).join(', ') || 'none'}`);
    changed();
  } catch (e) {
    console.warn(`[library] couldn't read installed libraries: ${(e as Error).message}`);
  }
}

/** Install (or update) a library from its file's contents. */
export async function installLibrary(raw: any): Promise<{ ok: boolean; message: string }> {
  const { lib, problems } = checkLibrary(raw);
  if (!lib) return { ok: false, message: `not installed: ${problems.join('; ')}` };
  const safe = safetyOf(raw);
  const report = safe.problems.length ? `\n${safetyReport(safe).join('\n')}` : '';
  console.info(`[library] safety check of ${lib.id} ${lib.version}: ${safe.ok ? 'passed' : 'BLOCKED'}${report}`);
  if (!safe.ok) return { ok: false, message: `not installed: the safety check blocked "${lib.name}": ${safe.problems.filter((p) => p.level === 'block').map((p) => `${p.where} ${p.what}`).join('; ')}` };
  const old = installed.get(lib.id);
  if (old) removeFromApp(old);
  try {
    addToApp(lib);
  } catch (e) {
    if (old) addToApp(old);
    return { ok: false, message: `not installed: its parts didn't build (${(e as Error).message})` };
  }
  await storage().put(lib);
  changed();
  console.info(`[library] installed ${lib.id} ${lib.version} (${lib.parts.length} parts)`);
  return { ok: true, message: `${old ? `updated "${lib.name}" from ${old.version} to` : `installed "${lib.name}"`} ${lib.version}: ${lib.parts.map((p) => p.name).join(', ')}${problems.length ? ` (${problems.join('; ')})` : ''}` };
}

/** Remove a library (not while its parts are on the bench). */
export async function removeLibrary(id: string, project: Project): Promise<{ ok: boolean; message: string }> {
  const lib = installed.get(id);
  if (!lib) return { ok: false, message: 'not installed' };
  const prefix = `${lib.id}/`;
  const used = project.parts.filter((p) => p.type.startsWith(prefix));
  if (used.length) return { ok: false, message: `"${lib.name}" is still in use on this bench (${used.map((p) => p.name).slice(0, 3).join(', ')}${used.length > 3 ? '...' : ''}): delete those parts first` };
  removeFromApp(lib);
  await storage().del(id);
  changed();
  return { ok: true, message: `removed "${lib.name}"` };
}

// ------------------------------------------------------------------------------------------ the shared list
export function registryUrl() {
  try { return localStorage.getItem(REGISTRY_KEY) || DEFAULT_REGISTRY; } catch { return DEFAULT_REGISTRY; }
}
export function setRegistryUrl(url: string) {
  try {
    if (!url || url === DEFAULT_REGISTRY) localStorage.removeItem(REGISTRY_KEY);
    else localStorage.setItem(REGISTRY_KEY, url);
  } catch { /* not kept */ }
}
export async function fetchRegistry(): Promise<RegistryEntry[]> {
  const url = registryUrl();
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`the library list at ${url} answered ${r.status}`);
  const index = await r.json();
  if (index?.format !== 'bench-library-index' || !Array.isArray(index.libraries)) throw new Error(`${url} is not a library list`);
  const base = new URL(url, location.href);
  return index.libraries
    .filter((e: any) => e && typeof e.id === 'string' && typeof e.url === 'string')
    .map((e: any) => ({ ...e, url: new URL(e.url, base).href }));
}
export async function installFromRegistry(e: RegistryEntry) {
  const r = await fetch(e.url, { cache: 'no-cache' });
  if (!r.ok) return { ok: false, message: `couldn't download "${e.name}" (${r.status})` };
  const res = await installLibrary(await r.json());
  if (res.ok) setOrigin(e.id, 'list');
  return res;
}

/** Versions: is a newer than b? (1.10.0 > 1.9.2) */
export function newer(a: string, b: string) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

// ------------------------------------------------------------------------------------------ projects
/** The libraries a project's parts come from (saved in the project, so whoever opens it knows what to install). */
export function librariesUsed(project: Project) {
  const ids = new Set(project.parts.filter((p) => p.type.includes('/')).map((p) => p.type.split('/')[0]));
  return [...ids].map((id) => installed.get(id)).filter((l): l is Library => !!l).map((l) => ({ id: l.id, name: l.name, version: l.version }));
}
/** Part types a project file needs that aren't here. */
export function missingTypes(raw: any): string[] {
  return [...new Set<string>((raw?.parts ?? []).map((p: any) => String(p?.type ?? '')))].filter((t) => t && !PART_BY_ID.has(t));
}

// ------------------------------------------------------------------------------------------ sketches
// "#include <LedControl.h>" in a program: the installed library that has it provides its code
sketchLibraries.resolve = (includes: string[]) => {
  const libs: { name: string; code: string; exports: string[] }[] = [];
  const classes: string[] = [];
  const missing: string[] = [];
  const defines: Record<string, number> = {};
  for (const inc of includes) {
    let found = false;
    for (const lib of installed.values()) {
      const f = lib.sketch?.[inc];
      if (!f) continue;
      libs.push({ name: `${inc} (library "${lib.name}" ${lib.version})`, code: f.code, exports: [...(f.classes ?? []), ...(f.exports ?? [])] });
      classes.push(...(f.classes ?? []));
      for (const [k, v] of Object.entries(f.defines ?? {})) if (/^[A-Za-z_]\w*$/.test(k) && Number.isFinite(v)) defines[k] = v;
      found = true;
      break;
    }
    if (!found) missing.push(inc);
  }
  return { libs, classes, missing, defines };
};

// ------------------------------------------------------------------------------------------ your own parts
/** Your own parts (imported KiCad boards, parts made in the app) live in one library: "My parts". */
export const MY_LIB = 'my-parts';
export async function saveMyPart(part: import('./format').LibPart) {
  const old = installed.get(MY_LIB);
  const parts = [...(old?.parts ?? []).filter((p) => p.id !== part.id), part];
  const v = (old?.version ?? '0.0.0').split('.').map(Number);
  const lib: Library = {
    format: 'bench-library',
    formatVersion: 1,
    id: MY_LIB,
    name: old?.name ?? 'My parts',
    version: `${v[0] || 1}.${v[1] || 0}.${(v[2] || 0) + (old ? 1 : 0)}`,
    author: old?.author ?? 'me',
    description: old?.description ?? 'Boards and parts I imported or made. Save it as a file to share them.',
    category: 'My boards',
    parts,
    code: old?.code,
    sketch: old?.sketch,
  };
  return installLibrary(lib);
}
export async function removeMyPart(partId: string, project: Project) {
  const old = installed.get(MY_LIB);
  if (!old) return { ok: false, message: 'nothing to remove' };
  if (project.parts.some((p) => p.type === `${MY_LIB}/${partId}`)) return { ok: false, message: 'that part is on the bench: delete it there first' };
  return installLibrary({ ...old, parts: old.parts.filter((p) => p.id !== partId) });
}

// ------------------------------------------------------------------------------------------ where each came from
/** list = installed from the shared list; file = a .benchlib someone shared; folder = one you're
 *  making (Install from folder); mine = your own parts (KiCad imports, Make a part) */
export type LibOrigin = 'list' | 'file' | 'folder' | 'mine';
const ORIGIN_KEY = 'bench.libraryOrigins';
export function setOrigin(id: string, origin: LibOrigin) {
  try {
    const m = JSON.parse(localStorage.getItem(ORIGIN_KEY) ?? '{}');
    m[id] = origin;
    localStorage.setItem(ORIGIN_KEY, JSON.stringify(m));
  } catch { /* not kept */ }
}
export function originOf(id: string, onList?: (id: string) => boolean): LibOrigin {
  if (id === MY_LIB) return 'mine';
  try {
    const o = JSON.parse(localStorage.getItem(ORIGIN_KEY) ?? '{}')[id];
    if (o) return o;
  } catch { /* unknown */ }
  return onList?.(id) ? 'list' : 'file';
}
