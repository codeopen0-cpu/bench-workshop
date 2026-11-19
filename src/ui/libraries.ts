// The Libraries window: what's on the shared library list (install, update), what's installed
// (remove, save as a file to share), install from a .benchlib file, make your own parts.
import type { Project } from '../project';
import { checkLibrary } from '../lib/format';
import { publishWindow } from './publish';
import { folderOf, libraryFromFolder, pickLibraryFolder, readFolder, rememberFolder } from '../lib/folder';
import { canOpenFolder, originOf, setOrigin, safetyOf, safetyReport, fetchRegistry, installed, installFromRegistry, installLibrary, librariesWhere, loadInstalled, newer, openLibrariesFolder, registryUrl, removeLibrary, setRegistryUrl, type RegistryEntry } from '../lib/store';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'string') e.setAttribute('style', v);
    else (e as any)[k] = v;
  }
  e.append(...kids);
  return e;
};

export interface LibrariesHost {
  project(): Project;
  log(msg: string, level?: 'info' | 'warn' | 'bad'): void;
  /** extra buttons (import a KiCad board, make a part): label -> action */
  makers: { label: string; title: string; run(): void }[];
  /** open a project (a library's example bench) */
  openProject(raw: any): void;
}

export class LibrariesWindow {
  private root: HTMLElement | null = null;
  private tab: 'browse' | 'installed' = 'browse';
  private list: RegistryEntry[] | null = null;
  private listError: string | null = null;
  private filter = '';
  private busy = new Set<string>();
  private where = '';

  constructor(private host: LibrariesHost) {}

  open(tab: 'browse' | 'installed' = this.tab) {
    this.tab = tab;
    if (!this.root) {
      this.root = el('div', { className: 'modal-back', onclick: (e: MouseEvent) => e.target === this.root && this.close() });
      document.body.append(this.root);
      document.addEventListener('keydown', this.esc);
    }
    this.render();
    if (!this.list && !this.listError) this.refreshList();
    librariesWhere().then((w) => {
      this.where = w;
      this.render();
    });
  }
  close() {
    this.root?.remove();
    this.root = null;
    document.removeEventListener('keydown', this.esc);
  }
  get isOpen() {
    return !!this.root;
  }
  private esc = (e: KeyboardEvent) => e.key === 'Escape' && this.close();

  async refreshList() {
    this.listError = null;
    this.list = null;
    this.render();
    try {
      this.list = await fetchRegistry();
      console.info(`[library] list from ${registryUrl()}: ${this.list.length} libraries`);
    } catch (e) {
      this.listError = (e as Error).message;
      console.warn(`[library] list failed: ${this.listError}`);
    }
    this.render();
  }

  private async act(key: string, fn: () => Promise<{ ok: boolean; message: string }>) {
    this.busy.add(key);
    this.render();
    try {
      const r = await fn();
      this.host.log(r.message, r.ok ? 'info' : 'warn');
    } catch (e) {
      this.host.log(`library: ${(e as Error).message}`, 'bad');
    }
    this.busy.delete(key);
    this.render();
  }

  /** Install a library straight from its folder (making one): the same checks as any install. */
  private async fromFolder(reloadId?: string) {
    let files, path: string | null = null;
    try {
      const known = reloadId ? folderOf(reloadId) : null;
      if (known && known !== '(picked)') {
        try {
          files = await readFolder(known);
          path = known;
        } catch {
          this.host.log(`couldn't read ${known} again: pick the folder`, 'warn');
        }
      }
      if (!files) {
        const got = await pickLibraryFolder();
        if (!got) return;
        files = got.files;
        path = got.path;
      }
      const raw = libraryFromFolder(files);
      await this.act(raw?.id ?? 'folder', async () => {
        const r = await installLibrary(raw);
        if (r.ok) {
          rememberFolder(raw.id, path ?? '(picked)');
          setOrigin(raw.id, 'folder');
        }
        console.info(`[library] ${reloadId ? 'reloaded' : 'installed'} ${raw?.id} from ${path ?? 'a picked folder'}: ${r.message}`);
        return r;
      });
      this.tab = 'installed';
      this.render();
    } catch (e) {
      this.host.log(`that folder isn't a library: ${(e as Error).message}`, 'bad');
    }
  }

  private async fromFile() {
    const { openText } = await import('../files');
    const f = await openText(['benchlib', 'json']);
    if (!f) return;
    let raw: any;
    try {
      raw = JSON.parse(f.text);
    } catch {
      return this.host.log(`${f.name} isn't a library file`, 'bad');
    }
    const { lib, problems } = checkLibrary(raw);
    if (!lib) return this.host.log(`${f.name}: ${problems.join('; ')}`, 'bad');
    const safe = safetyOf(raw);
    if (!safe.ok) {
      alert(`"${lib.name}" can't be installed: the safety check blocked it.\n\n${safetyReport(safe).join('\n')}`);
      return this.host.log(`${lib.name}: blocked by the safety check`, 'bad');
    }
    const code = lib.code ? ' It includes code, which runs sealed off from your files and the internet.' : '';
    const warns = safe.problems.length ? `\n\nThe safety check found nothing dangerous, but notes:\n${safetyReport(safe).join('\n')}` : '\n\nThe safety check passed.';
    if (!confirm(`Install "${lib.name}" ${lib.version} by ${lib.author}?\n\n${lib.description}${code}${warns}`)) return;
    await this.act(lib.id, async () => {
      const r = await installLibrary(raw);
      if (r.ok) setOrigin(lib.id, 'file');
      return r;
    });
    this.tab = 'installed';
    this.render();
  }

  private async saveAs(id: string) {
    const lib = installed.get(id);
    if (!lib) return;
    const { saveText } = await import('../files');
    const path = await saveText(`${lib.id}.benchlib`, JSON.stringify(lib));
    if (path) this.host.log(`saved ${lib.name} as ${path}: anyone can install it with Libraries > Install from file`);
  }

  /** the tab the list was last drawn for (redrawing the same one keeps its scroll place) */
  private drawnTab = '';
  private render() {
    if (!this.root) return;
    // where the list was scrolled to: an install (or an update, or Remove) redraws the window, and
    // the list should stay where you were, not jump back to the top
    const prev = this.root.querySelector<HTMLElement>('.lib-body');
    const keepScroll = prev && this.drawnTab === this.tab ? prev.scrollTop : 0;
    const hadFocus = document.activeElement?.classList.contains('lib-search') || !prev;
    const tabBtn = (t: typeof this.tab, label: string) =>
      el('button', { className: `tab ${this.tab === t ? 'active' : ''}`, textContent: label, onclick: () => { this.tab = t; this.render(); } });
    const search = el('input', { type: 'search', placeholder: 'Search libraries', value: this.filter, className: 'lib-search' }) as HTMLInputElement;
    search.oninput = () => {
      this.filter = search.value;
      this.renderBody(body);
    };
    const body = el('div', { className: 'lib-body' });
    const win = el('div', { className: 'modal lib-window' },
      el('div', { className: 'modal-head' },
        el('div', { className: 'modal-title', textContent: 'Libraries' }),
        el('div', { className: 'modal-sub', textContent: 'Add-on parts: displays, sensors, boards... Installed ones show up in the parts list.' }),
        el('button', { className: 'modal-x', textContent: '×', title: 'Close (Esc)', onclick: () => this.close() })),
      el('div', { className: 'lib-tabs' }, tabBtn('browse', 'Browse'), tabBtn('installed', `Installed (${installed.size})`), search),
      body,
      el('div', { className: 'lib-foot' },
        el('button', { textContent: 'Install from file...', title: 'Install a .benchlib file someone shared', onclick: () => this.fromFile() }),
        el('button', { textContent: 'Install from folder...', title: 'Making a library: install it straight from its folder (library.json, device.js...), then Reload after each change', onclick: () => this.fromFolder() }),
        ...this.host.makers.map((m) => el('button', { textContent: m.label, title: m.title, onclick: () => { this.close(); m.run(); } })),
        el('span', { style: 'flex:1' }),
        el('button', { textContent: 'How to make one', title: 'The guide: make your own part (shape, pins, what it does, its Arduino library) and test it', onclick: async () => {
          const url = 'https://github.com/codeopen0-cpu/bench-workshop-libraries/blob/main/GUIDE.md';
          if ('__TAURI_INTERNALS__' in window) (await import('@tauri-apps/plugin-opener')).openUrl(url);
          else window.open(url, '_blank', 'noopener');
        } }),
        el('button', { textContent: 'List address...', title: `Where the library list comes from: ${registryUrl()}`, onclick: () => {
          const u = prompt('Library list address (index.json). Empty = the default list.', registryUrl());
          if (u === null) return;
          setRegistryUrl(u.trim());
          this.refreshList();
        } })));
    this.root.replaceChildren(win);
    this.renderBody(body);
    body.scrollTop = keepScroll;
    this.drawnTab = this.tab;
    // (open it and type: the search is ready; but a redraw after clicking Install leaves focus alone)
    if (hadFocus) search.focus({ preventScroll: true });
  }

  private renderBody(body: HTMLElement) {
    // every word typed has to be somewhere in it (name, what it is, who made it, its parts...)
    const f = this.filter.trim().toLowerCase();
    const words = f.split(/\s+/).filter(Boolean);
    const match = (...xs: (string | undefined)[]) => {
      const hay = xs.filter(Boolean).join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    };
    const count = (n: number, of: number) => (words.length ? [el('div', { className: 'lib-count', textContent: `${n} of ${of} ${of === 1 ? 'library' : 'libraries'} match "${this.filter.trim()}"` })] : []);
    const rows: HTMLElement[] = [];
    if (this.tab === 'browse') {
      if (this.listError) rows.push(el('div', { className: 'lib-note bad' }, `Couldn't get the library list: ${this.listError}. `, el('a', { href: '#', textContent: 'Try again', onclick: (e: Event) => { e.preventDefault(); this.refreshList(); } })));
      else if (!this.list) rows.push(el('div', { className: 'lib-note', textContent: 'Getting the library list...' }));
      else {
        const shown = this.list.filter((e) => match(e.id, e.name, e.description, e.author, e.category, ...(e.parts ?? []), ...(e.can ?? [])));
        rows.push(...count(shown.length, this.list.length));
        if (!shown.length) rows.push(el('div', { className: 'lib-note', textContent: f ? 'Nothing matches that. Try fewer or shorter words (e.g. "oled", "servo", "i2c").' : 'The list is empty.' }));
        for (const e of shown) {
          const have = installed.get(e.id);
          const busy = this.busy.has(e.id);
          const btn = !have
            ? el('button', { className: 'primary', textContent: busy ? 'Installing...' : 'Install', disabled: busy, onclick: () => this.act(e.id, () => installFromRegistry(e)) })
            : newer(e.version, have.version)
              ? el('button', { className: 'primary', textContent: busy ? 'Updating...' : `Update to ${e.version}`, disabled: busy, onclick: () => this.act(e.id, () => installFromRegistry(e)) })
              : el('span', { className: 'lib-have', textContent: 'Installed' });
          rows.push(this.row(e.name, e.version, e.author, e.description, e.category, e.parts ?? [], btn, e.can?.length ? [el('span'), el('div', { className: 'lib-can', textContent: `Its parts: ${e.can.join(' · ')}` })] : []));
        }
      }
    } else {
      rows.push(el('div', { className: 'lib-where' },
        el('span', { textContent: `Kept in ${this.where || '...'}` }),
        el('span', { style: 'flex:1' }),
        ...(canOpenFolder() ? [el('button', { textContent: 'Open folder', title: 'Each library is one .benchlib file there: drop one in, or delete one, then Rescan', onclick: () => openLibrariesFolder()?.catch((e) => this.host.log(`couldn't open the folder: ${e?.message ?? e}`, 'bad')) })] : []),
        el('button', { textContent: 'Rescan', title: 'Read the libraries folder again (after adding or removing files by hand)', onclick: async () => {
          await loadInstalled();
          this.host.log(`${installed.size} libraries installed`);
          this.render();
        } })));
      const libs = [...installed.values()].filter((l) => match(l.id, l.name, l.description, l.author, l.category, ...l.parts.map((p) => `${p.name} ${p.description ?? ''}`), ...(l.examples ?? []).map((x) => x.name), ...Object.keys(l.sketch ?? {})));
      rows.push(...count(libs.length, installed.size));
      if (!libs.length) rows.push(el('div', { className: 'lib-note', textContent: installed.size ? 'Nothing matches that.' : 'No libraries yet: find some under Browse.' }));
      const onList = (id: string) => !!this.list?.some((e) => e.id === id);
      const ORIGIN = { list: 'from the library list', file: 'from a file', folder: 'yours, in progress (from its folder)', mine: 'your own parts' } as const;
      for (const l of libs) {
        const busy = this.busy.has(l.id);
        const origin = originOf(l.id, onList);
        const yours = origin !== 'list'; // (publishing a library that came off the list makes no sense)
        // its example benches: links under the description
        const examples = (l.examples ?? []).length
          ? [el('div', { className: 'lib-examples' }, 'Try it: ', ...(l.examples ?? []).flatMap((ex, i) => [
              ...(i ? [', '] : []),
              el('a', { href: '#', textContent: ex.name, title: ex.description ?? 'A ready-wired bench with the parts of this library', onclick: (e: Event) => { e.preventDefault(); this.close(); this.host.openProject(ex.project); } }),
            ]))]
          : [];
        const folder = folderOf(l.id);
        rows.push(this.row(l.name, l.version, l.author, l.description, l.category, l.parts.map((p) => p.name),
          el('div', { className: 'lib-btns' },
            ...(origin === 'folder' && folder ? [el('button', { textContent: 'Reload', title: `Read it again from its folder${folder !== '(picked)' ? ` (${folder})` : ''}, after you changed something`, onclick: () => this.fromFolder(l.id) })] : []),
            ...(yours ? [el('button', { className: 'primary', textContent: 'Publish...', title: 'Send it to the shared library list (a GitHub pull request, safety-checked and reviewed)', onclick: () => { this.close(); publishWindow(l, (m, lv) => this.host.log(m, lv)); } })] : []),
            el('button', { textContent: 'Save as file', title: 'Save it as a .benchlib file to share', onclick: () => this.saveAs(l.id) }),
            el('button', { className: 'danger', textContent: busy ? 'Removing...' : 'Remove', disabled: busy, onclick: () => this.act(l.id, () => removeLibrary(l.id, this.host.project())) })),
          [el('span', { className: `lib-origin lib-origin-${origin}`, textContent: ORIGIN[origin] }), ...examples]));
      }
    }
    body.replaceChildren(...rows);
  }

  private row(name: string, version: string, author: string, description: string, category: string | undefined, parts: string[], action: HTMLElement, extra: HTMLElement[] = []) {
    return el('div', { className: 'lib-row' },
      el('div', { className: 'lib-main' },
        el('div', { className: 'lib-name' }, name, el('span', { className: 'lib-ver', textContent: ` ${version}` }), ...(extra[0] ? [' ', extra[0]] : [])),
        el('div', { className: 'lib-meta', textContent: `${category ? `${category} · ` : ''}by ${author}${parts.length ? ` · parts: ${parts.join(', ')}` : ''}` }),
        el('div', { className: 'lib-desc', textContent: description }),
        ...extra.slice(1)),
      action);
  }
}
