// Your own parts: import a KiCad board, or make a board in the app (size, colour, header rows, and
// optionally a microcontroller that runs sketches). Both go into your "My parts" library.
import type { LibPart, LibPinRow } from '../lib/format';
import { readKicadPcb, isConnector, kicadPart, type KicadBoard } from '../lib/kicad';
import { installed, MY_LIB, removeMyPart, saveMyPart } from '../lib/store';
import type { PinKind } from '../parts/types';
import type { Project } from '../project';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'string') e.setAttribute('style', v);
    else (e as any)[k] = v;
  }
  e.append(...kids);
  return e;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'part';

interface Host {
  project(): Project;
  log(msg: string, level?: 'info' | 'warn' | 'bad'): void;
  /** after saving: start placing the new part */
  place(typeId: string): void;
}

function modal(title: string, sub: string, onClose: () => void) {
  const back = el('div', { className: 'modal-back' });
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', esc);
    onClose();
  };
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
  document.addEventListener('keydown', esc);
  back.onclick = (e) => e.target === back && close();
  const body = el('div', { className: 'pm-body' });
  const foot = el('div', { className: 'lib-foot' });
  back.append(el('div', { className: 'modal pm-window' },
    el('div', { className: 'modal-head' },
      el('div', { className: 'modal-title', textContent: title }),
      el('div', { className: 'modal-sub', textContent: sub }),
      el('button', { className: 'modal-x', textContent: '×', title: 'Close (Esc)', onclick: close })),
    body, foot));
  document.body.append(back);
  return { body, foot, close };
}
const field = (label: string, input: HTMLElement, hint?: string) =>
  el('label', { className: 'pm-field' }, el('span', { textContent: label }), input, ...(hint ? [el('small', { textContent: hint })] : []));
const input = (props: Record<string, any>) => el('input', { className: 'pm-input', ...props }) as HTMLInputElement;

// ------------------------------------------------------------------------------------------ KiCad import
export async function importKicad(host: Host) {
  const { openText, openBinary } = await import('../files');
  const f = await openText(['kicad_pcb'], 'KiCad board');
  if (!f) return;
  let board: KicadBoard;
  try {
    board = readKicadPcb(f.text, f.name.split(/[\\/]/).pop() ?? f.name);
  } catch (e) {
    return host.log(`couldn't read ${f.name}: ${(e as Error).message}`, 'bad');
  }
  console.info(`[kicad] ${board.name}: ${board.w.toFixed(1)} x ${board.h.toFixed(1)} mm, ${board.footprints.length} footprints, connectors: ${board.footprints.filter(isConnector).map((x) => x.ref).join(' ')}`);
  let glb: { name: string; b64: string } | null = null;
  const m = modal('Import a KiCad board', `${board.name}: ${(board.w / 10).toFixed(1)} x ${(board.h / 10).toFixed(1)} cm, ${board.footprints.length} parts on it`, () => {});
  const name = input({ type: 'text', value: board.name });
  const color = input({ type: 'color', value: '#1d6b3a' });
  const which = el('select', { className: 'pm-input' },
    el('option', { value: 'conn', textContent: 'Connectors and headers only (J, P, CN... )' }),
    el('option', { value: 'tht', textContent: 'Every through-hole pad' })) as HTMLSelectElement;
  const glbNote = el('span', { textContent: 'none: drawn as a plain board with blocks for its parts' });
  const pickGlb = el('button', { textContent: 'Choose .glb...', onclick: async () => {
    const g = await openBinary(['glb'], 'KiCad 3D export');
    if (!g) return;
    let s = '';
    for (let i = 0; i < g.bytes.length; i += 0x8000) s += String.fromCharCode(...g.bytes.subarray(i, i + 0x8000));
    glb = { name: g.name.split(/[\\/]/).pop() ?? g.name, b64: btoa(s) };
    glbNote.textContent = `${glb.name} (${(g.bytes.length / 1024 / 1024).toFixed(1)} MB)`;
  } });
  const conns = board.footprints.filter(isConnector);
  m.body.append(
    field('Name', name),
    field('Board colour', color, '(when there is no 3D model)'),
    field('Pins on the bench', which, `Connectors found: ${conns.map((c) => `${c.ref} (${c.pads.length})`).join(', ') || 'none'}`),
    field('3D model (optional)', el('div', { className: 'pm-row' }, pickGlb, glbNote), 'KiCad: File > Export > glTF (.glb). Its look replaces the plain board.'),
    el('div', { className: 'pm-note', textContent: 'Pins on the same net are joined, like the board\'s copper. To give the board a program or chip behaviour, put it in a library with code (see the library guide).' }),
  );
  m.foot.append(el('span', { style: 'flex:1' }), el('button', { textContent: 'Cancel', onclick: m.close }), el('button', { className: 'primary', textContent: 'Import', onclick: async () => {
    const part = kicadPart(board, { id: slug(name.value), name: name.value.trim() || board.name, color: color.value, connectorsOnly: which.value === 'conn', glb: glb?.b64 });
    const r = await saveMyPart(part);
    host.log(r.ok ? `${part.name}: imported (${part.pins?.length ?? 0} pins) into My parts` : r.message, r.ok ? 'info' : 'bad');
    // what the design check found on the board itself (from its pins' types)
    const found = part.designIssues ?? [];
    const broken = found.filter((d) => d.level === 'fault');
    console.info(`[kicad] design check of ${part.name}: ${found.map((d) => `${d.level}: ${d.what}`).join(' | ') || 'nothing found'}`);
    if (r.ok && broken.length) alert(`${part.name}: the design check found ${broken.length} problem${broken.length > 1 ? 's' : ''} on the board itself:\n\n${broken.map((d) => `- ${d.what}`).join('\n')}\n\nCheck (in the toolbar) lists them whenever the board is on the bench.`);
    else if (r.ok && found.length) host.log(`${part.name}: the design check has ${found.length} note${found.length > 1 ? 's' : ''}: press Check once it's on the bench`, 'warn');
    if (r.ok) {
      m.close();
      host.place(`${MY_LIB}/${part.id}`);
    }
  } }));
}

// ------------------------------------------------------------------------------------------ 3D model (.stl)
/** Bring in a 3D model (.stl) as a part: see how your own design looks and works on the bench. */
export async function importModel(host: Host) {
  const { openBinary } = await import('../files');
  const M = await import('../lib/model');
  const f = await openBinary(['stl'], '3D model (STL)');
  if (!f) return;
  const fileName = f.name.split(/[\\/]/).pop() ?? f.name;
  let src: import('three').BufferGeometry;
  try {
    src = M.readStl(f.bytes);
  } catch (e) {
    return host.log(`couldn't read ${fileName}: ${(e as Error).message}`, 'bad');
  }
  const tris = src.getAttribute('position').count / 3;
  console.info(`[model] ${fileName}: ${tris} triangles, ${(f.bytes.length / 1048576).toFixed(2)} MB`);
  if (tris > M.MAX_TRIANGLES) {
    src.dispose();
    return host.log(`${fileName} has ${tris.toLocaleString()} triangles: at most ${M.MAX_TRIANGLES.toLocaleString()}. Export it coarser (or decimate it in Blender) and try again.`, 'bad');
  }
  const m = modal('Import a 3D model', `${fileName}: ${tris.toLocaleString()} triangles. It goes into your "My parts" library, under My models.`, () => src.dispose());
  const name = input({ type: 'text', value: fileName.replace(/\.stl$/i, '') });
  const color = input({ type: 'color', value: '#e07a2e' });
  const unit = el('select', { className: 'pm-input' },
    el('option', { value: 'mm', textContent: 'millimetres (3D printing, most CAD)' }),
    el('option', { value: 'cm', textContent: 'centimetres' }),
    el('option', { value: 'in', textContent: 'inches' }),
    el('option', { value: 'm', textContent: 'metres (Blender)' })) as HTMLSelectElement;
  const up = el('select', { className: 'pm-input' },
    el('option', { value: 'z', textContent: 'Z is up (CAD, slicers)' }),
    el('option', { value: 'y', textContent: 'Y is up' })) as HTMLSelectElement;
  const scale = input({ type: 'number', value: '100', min: '1', max: '10000', step: '1' });
  const material = el('select', { className: 'pm-input' },
    ...M.MATERIALS.map((x) => el('option', { value: x.id, textContent: x.label })),
    el('option', { value: 'custom', textContent: 'I know its weight' })) as HTMLSelectElement;
  const grams = input({ type: 'number', value: '20', min: '0.5', step: '0.5', disabled: true });
  const fit = el('select', { className: 'pm-input' },
    el('option', { value: 'detailed', textContent: 'Detailed: holes and hollows stay open (a few convex pieces)' }),
    el('option', { value: 'simple', textContent: 'Simple: wrapped (one piece, like shrink wrap)' }),
    el('option', { value: 'box', textContent: 'Box: just its box' })) as HTMLSelectElement;
  const info = el('div', { className: 'pm-note' });
  let prep: ReturnType<typeof M.prepareModel> | null = null;
  const density = () => M.MATERIALS.find((x) => x.id === material.value)?.density ?? 1;
  const update = () => {
    prep?.geo.dispose();
    prep = M.prepareModel(src, unit.value as any, up.value === 'z', Math.max(0.01, Number(scale.value) || 100) / 100);
    const [w, h, d] = prep.size;
    grams.disabled = material.value !== 'custom';
    if (material.value !== 'custom' && prep.closed) grams.value = String(+(prep.volume * density()).toFixed(1));
    info.textContent = `${w.toFixed(1)} wide x ${h.toFixed(1)} high x ${d.toFixed(1)} deep (cm)  ·  ${prep.triangles.toLocaleString()} triangles  ·  ` +
      (prep.closed ? `${prep.volume.toFixed(1)} cm³ of material` : 'its surface has gaps (not watertight): the weight comes from its solid shape') +
      (Math.max(w, h, d) > 300 ? '  ·  that is over 3 m: is the unit right?' : Math.max(w, h, d) < 0.2 ? '  ·  under 2 mm: is the unit right?' : '');
  };
  for (const x of [unit, up, scale, material]) x.addEventListener('change', update);
  scale.addEventListener('input', update);
  update();
  m.body.append(
    el('div', { className: 'pm-grid' }, field('Name', name), field('Colour', color), field('Units in the file', unit), field('Which way is up', up), field('Scale (%)', scale), field('Made of', material)),
    field('Weight (g)', grams, 'Worked out from its volume and what it is made of; choose "I know its weight" to type it.'),
    field('Physical shape', fit, 'What touches, rolls and stacks. Detailed takes a moment on import (only once).'),
    info,
    el('div', { className: 'pm-note', textContent: 'Once placed it is a part like any other: glue things to it, glue it to things, pin it to the bench, pick it up while running.' }),
  );
  const go = el('button', { className: 'primary', textContent: 'Import' }) as HTMLButtonElement;
  go.onclick = async () => {
    if (!prep) return;
    go.disabled = true;
    go.textContent = 'Working out its shape...';
    await new Promise((r) => setTimeout(r, 30)); // (let the button say so before the work starts)
    try {
      const shape = await M.solidShape(prep, fit.value as any);
      const hullVol = shape.hulls.reduce((s, h) => s + h.vol, 0);
      const vol = prep.closed ? prep.volume : hullVol;
      const mass = material.value === 'custom' ? Number(grams.value) || 20 : Math.max(0.5, vol * density());
      console.info(`[model] ${name.value}: shape ${fit.value} -> ${shape.how} in ${shape.ms.toFixed(0)} ms (pieces' volume ${hullVol.toFixed(1)} cm³, model ${prep.volume.toFixed(1)} cm³), ${mass.toFixed(1)} g`);
      if (!shape.hulls.length) throw new Error('it has no solid shape (is it flat?)');
      const nm = name.value.trim() || 'My model';
      const part = M.modelPart({ id: slug(nm), name: nm, color: color.value, prep, hulls: shape.hulls, mass,
        description: `Imported from ${fileName}: ${prep.size.map((x) => x.toFixed(1)).join(' x ')} cm, ${mass.toFixed(0)} g, solid shape: ${shape.how}.` });
      const r = await saveMyPart(part);
      host.log(r.ok ? `${nm}: imported into My parts (${prep.size.map((x) => x.toFixed(1)).join(' x ')} cm, ${mass.toFixed(0)} g, ${shape.how})` : r.message, r.ok ? 'info' : 'bad');
      if (r.ok) {
        m.close();
        host.place(`${MY_LIB}/${part.id}`);
      }
    } catch (e) {
      host.log(`couldn't import ${fileName}: ${(e as Error).message}`, 'bad');
    } finally {
      go.disabled = false;
      go.textContent = 'Import';
    }
  };
  m.foot.append(el('span', { style: 'flex:1' }), el('button', { textContent: 'Cancel', onclick: m.close }), go);
}

// ------------------------------------------------------------------------------------------ part maker
interface RowForm { pins: HTMLInputElement; x: HTMLInputElement; z: HTMLInputElement; dir: HTMLSelectElement }

const kindOf = (id: string): PinKind => {
  const n = id.toUpperCase();
  if (/^GND\d*$|^VSS$/.test(n)) return 'gnd';
  if (/^(SDA|SCL)$/.test(n)) return 'i2c';
  if (/^(VIN|VCC|VDD|VBAT|\+?\d+V\d*|3V3|5V)$/.test(n)) return n === 'VIN' || n === 'VCC' || n === 'VBAT' ? 'vin' : 'vout';
  return 'io';
};
/** Arduino-style pin numbers from names: D7 / GP7 / IO7 / 7 -> 7, A0-A5 -> 26-31 */
const pinNumber = (id: string) => {
  const m = /^(?:D|GP|IO|P)?(\d+)$/i.exec(id);
  if (m) return Number(m[1]);
  const a = /^A(\d)$/i.exec(id);
  return a ? 26 + Number(a[1]) : undefined;
};

export function makePart(host: Host, startFrom?: string) {
  const mine = installed.get(MY_LIB)?.parts ?? [];
  const m = modal('Make a part', 'A board with header rows, made here. It goes into your "My parts" library.', () => {});
  const pick = el('select', { className: 'pm-input' }, el('option', { value: '', textContent: '(a new part)' }), ...mine.map((p) => el('option', { value: p.id, textContent: p.name, selected: p.id === startFrom }))) as HTMLSelectElement;
  const name = input({ type: 'text', value: 'My board' });
  const color = input({ type: 'color', value: '#1d6b3a' });
  const w = input({ type: 'number', value: '5', min: '0.5', step: '0.1' });
  const d = input({ type: 'number', value: '3', min: '0.5', step: '0.1' });
  const t = input({ type: 'number', value: '0.16', min: '0.05', step: '0.01' });
  const mass = input({ type: 'number', value: '8', min: '0.5', step: '0.5' });
  const desc = input({ type: 'text', value: '', placeholder: 'What it is, how to wire it' });
  const prog = input({ type: 'checkbox' });
  // an optional 3D model for its look (metres, Y up, like KiCad's or Blender's .glb export)
  let glb: string | undefined;
  const glbNote = el('span', { textContent: 'none: drawn as a plain board' });
  const glbUp = input({ type: 'number', value: '0', step: '0.01', style: 'width:80px', title: 'Raise or lower the model (cm)' });
  const pickGlb = el('button', { textContent: 'Choose .glb...', onclick: async () => {
    const { openBinary } = await import('../files');
    const g = await openBinary(['glb'], '3D model');
    if (!g) return;
    let s = '';
    for (let i = 0; i < g.bytes.length; i += 0x8000) s += String.fromCharCode(...g.bytes.subarray(i, i + 0x8000));
    glb = btoa(s);
    glbNote.textContent = `${g.name.split(/[\\/]/).pop()} (${(g.bytes.length / 1048576).toFixed(1)} MB)`;
  } });
  const dropGlb = el('button', { textContent: 'No model', onclick: () => { glb = undefined; glbNote.textContent = 'none: drawn as a plain board'; } });
  const logic = el('select', { className: 'pm-input' }, el('option', { value: '3.3', textContent: '3.3 V logic' }), el('option', { value: '5', textContent: '5 V logic' })) as HTMLSelectElement;
  const rowsBox = el('div', { className: 'pm-rows' });
  const rows: RowForm[] = [];
  const addRow = (pins = '', x = 0.3, z = 0.3, dir: 'x' | 'z' = 'x') => {
    const r: RowForm = {
      pins: input({ type: 'text', value: pins, placeholder: 'GND, VCC, D2, D3, SDA, SCL', style: 'flex:3' }),
      x: input({ type: 'number', value: String(x), step: '0.254', style: 'width:70px' }),
      z: input({ type: 'number', value: String(z), step: '0.254', style: 'width:70px' }),
      dir: el('select', { className: 'pm-input' }, el('option', { value: 'x', textContent: 'across', selected: dir === 'x' }), el('option', { value: 'z', textContent: 'down', selected: dir === 'z' })) as HTMLSelectElement,
    };
    rows.push(r);
    const line = el('div', { className: 'pm-row' }, r.pins, el('span', { textContent: 'x' }), r.x, el('span', { textContent: 'z' }), r.z, r.dir,
      el('button', { textContent: '×', title: 'Remove this row', onclick: () => { rows.splice(rows.indexOf(r), 1); line.remove(); } }));
    rowsBox.append(line);
  };
  const fill = (p: LibPart | undefined) => {
    rows.length = 0;
    rowsBox.replaceChildren();
    if (!p) {
      addRow('GND, VCC, D2, D3, D4, D5', 0.3, 0.3);
      return;
    }
    const board = p.shape[0]?.box ?? [5, 0.16, 3];
    name.value = p.name;
    color.value = p.shape[0]?.color ?? '#1d6b3a';
    w.value = String(board[0]);
    d.value = String(board[2]);
    t.value = String(board[1]);
    mass.value = String(p.mass);
    desc.value = p.description ?? '';
    prog.checked = !!p.sketch;
    glb = p.glb;
    glbNote.textContent = p.glb ? `kept (${(p.glb.length * 0.75 / 1048576).toFixed(1)} MB)` : 'none: drawn as a plain board';
    glbUp.value = String(p.glbAt ? +(p.glbAt[1] - board[1]).toFixed(3) : 0);
    logic.value = String(p.sketch?.logicV ?? 3.3);
    for (const r of p.pinRows ?? []) addRow(r.ids.join(', '), +(r.at[0] + board[0] / 2).toFixed(3), +(r.at[2] + board[2] / 2).toFixed(3), r.dir ?? 'x');
  };
  pick.onchange = () => fill(mine.find((p) => p.id === pick.value));
  fill(mine.find((p) => p.id === startFrom));

  m.body.append(
    field('Start from', pick),
    el('div', { className: 'pm-grid' }, field('Name', name), field('Colour', color), field('Width (cm, across)', w), field('Depth (cm, front to back)', d), field('Thickness (cm)', t), field('Weight (g)', mass)),
    field('Description', desc),
    field('3D model (optional)', el('div', { className: 'pm-row' }, pickGlb, dropGlb, glbNote, el('span', { textContent: 'raise (cm)' }), glbUp),
      'A .glb in metres with Y up (KiCad: File > Export > glTF; Blender: export glTF binary), centred on the board. It replaces the plain board look; the pins stay where the rows say.'),
    el('div', { className: 'pm-sub', textContent: 'Header rows: pin names in order, where the first pin is (cm from the board\'s back-left corner), and which way the row runs. Every GND pin (GND, GND2...) is joined to the others.' }),
    rowsBox,
    el('div', { className: 'pm-row' }, el('button', { textContent: '+ Add a row', onclick: () => addRow('', 0.3, Number(d.value) - 0.3) })),
    field('Microcontroller', el('div', { className: 'pm-row' }, prog, el('span', { textContent: 'It runs sketches written in the app' }), logic),
      'Pin numbers come from the names: D7, GP7, IO7 or 7 = pin 7; A0-A5 = analog 26-31. Power: VIN (5-12 V) and GND, or its USB.'),
  );
  m.foot.append(
    ...(startFrom || mine.length ? [el('button', { className: 'danger', textContent: 'Delete part', title: 'Remove the chosen part from My parts', onclick: async () => {
      if (!pick.value || !confirm(`Delete "${pick.selectedOptions[0].textContent}" from My parts?`)) return;
      const r = await removeMyPart(pick.value, host.project());
      host.log(r.message, r.ok ? 'info' : 'warn');
      if (r.ok) m.close();
    } })] : []),
    el('span', { style: 'flex:1' }),
    el('button', { textContent: 'Cancel', onclick: m.close }),
    el('button', { className: 'primary', textContent: 'Save part', onclick: async () => {
      const W = Number(w.value) || 5, D = Number(d.value) || 3, T = Number(t.value) || 0.16;
      const pinRows: LibPinRow[] = [];
      const all: string[] = [];
      for (const r of rows) {
        const ids = r.pins.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (!ids.length) continue;
        for (const id of ids) if (all.includes(id)) return host.log(`two pins are called ${id}: give each pin its own name`, 'warn');
        all.push(...ids);
        pinRows.push({ ids, at: [Number(r.x.value) - W / 2, T, Number(r.z.value) - D / 2], dir: r.dir.value as 'x' | 'z', kinds: Object.fromEntries(ids.map((id) => [id, kindOf(id)])) });
      }
      const nm = name.value.trim() || 'My board';
      const part: LibPart = {
        id: pick.value || slug(nm),
        name: nm,
        category: 'My boards',
        description: desc.value.trim() || undefined,
        swatch: color.value,
        mass: Number(mass.value) || 8,
        shape: [{ box: [W, T, D], at: [0, T / 2, 0], color: color.value }],
        glb,
        glbAt: glb ? [0, T + (Number(glbUp.value) || 0), 0] : undefined,
        pinRows,
        // grounds are one net on any real board
        shorts: all.filter((id) => kindOf(id) === 'gnd').slice(1).map((id) => [all.find((x) => kindOf(x) === 'gnd')!, id] as [string, string]),
      };
      if (prog.checked) {
        const pins: Record<string, number> = {};
        for (const id of all) {
          const n = pinNumber(id);
          if (n !== undefined && kindOf(id) === 'io') pins[id] = n;
        }
        const vin = all.find((id) => /^VIN$/i.test(id)) ?? all.find((id) => kindOf(id) === 'vin');
        const gnd = all.find((id) => kindOf(id) === 'gnd');
        if (!gnd) return host.log('a board with a microcontroller needs a GND pin', 'warn');
        part.sketch = { pins, analog: all.filter((id) => /^A\d$/i.test(id)), logicV: Number(logic.value), power: { vin: vin ?? gnd, gnd, min: 4.5, max: 12.5 }, usb: true };
        part.params = [{ key: 'usb', label: 'USB cable plugged in (5 V)', kind: 'bool' }];
        part.defaults = { usb: true };
        if (vin) for (const r of pinRows) if (r.ids.includes(vin)) r.extra = { ...(r.extra ?? {}), [vin]: { label: `${vin} (5-12 V)`, vmin: 4.5, vmax: 12.5 } };
        part.shape.push({ box: [Math.min(1.2, W * 0.4), 0.12, Math.min(1.2, D * 0.4)], at: [0, T + 0.06, 0], color: '#151618', collide: false });
      }
      const r = await saveMyPart(part);
      host.log(r.ok ? `${part.name} saved in My parts (${all.length} pins)` : r.message, r.ok ? 'info' : 'bad');
      if (r.ok) {
        m.close();
        host.place(`${MY_LIB}/${part.id}`);
      }
    } }),
  );
}
