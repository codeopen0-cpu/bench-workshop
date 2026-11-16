// The Publish window: send one of your libraries (or some of your own parts) to the shared list.
import type { Library } from '../lib/format';
import { finishSignIn, GITHUB_CLIENT_ID, LIST_REPO, listedVersion, publishLibrary, signedInAs, startSignIn } from '../lib/publish';
import { MY_LIB, newer, safetyOf, safetyReport } from '../lib/store';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'string') e.setAttribute('style', v);
    else (e as any)[k] = v;
  }
  e.append(...kids);
  return e;
};
const inTauri = () => '__TAURI_INTERNALS__' in window;
async function openLink(url: string) {
  if (inTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener');
}

export function publishWindow(lib: Library, log: (m: string, l?: 'info' | 'warn' | 'bad') => void) {
  const back = el('div', { className: 'modal-back' });
  let cancelled = false;
  const close = () => {
    cancelled = true;
    back.remove();
    document.removeEventListener('keydown', esc);
  };
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
  document.addEventListener('keydown', esc);
  const mine = lib.id === MY_LIB;
  const input = (props: Record<string, any>) => el('input', { className: 'pm-input', ...props }) as HTMLInputElement;
  const name = input({ type: 'text', value: mine ? '' : lib.name, placeholder: 'e.g. Rain sensor board' });
  const id = input({ type: 'text', value: mine ? '' : lib.id, placeholder: 'lowercase-with-dashes' });
  const version = input({ type: 'text', value: lib.version });
  const author = input({ type: 'text', value: lib.author === 'me' ? signedInAs() ?? '' : lib.author });
  const category = input({ type: 'text', value: lib.category && lib.category !== 'My boards' ? lib.category : '', placeholder: 'Displays, Sensors, Boards...' });
  const desc = el('textarea', { className: 'pm-input', rows: 3, value: mine ? '' : lib.description, placeholder: 'What it is and what it is for' }) as HTMLTextAreaElement;
  name.oninput = () => {
    if (mine && !id.dataset.touched) id.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  };
  id.oninput = () => (id.dataset.touched = '1');
  const picks = lib.parts.map((p) => ({ p, box: input({ type: 'checkbox', checked: true }) }));
  const status = el('div', { className: 'pm-note' });
  const signBox = el('div', { className: 'pm-row' });
  const goBtn = el('button', { className: 'primary', textContent: 'Publish' }) as HTMLButtonElement;

  const build = (): Library => ({
    ...lib,
    // whose it is on the list: yours, when you publish it (an update keeps its owner)
    owner: lib.owner && !mine ? lib.owner : signedInAs() ?? lib.owner,
    id: id.value.trim(),
    name: name.value.trim(),
    version: version.value.trim(),
    author: author.value.trim(),
    category: category.value.trim() || undefined,
    description: desc.value.trim(),
    parts: picks.filter((x) => x.box.checked).map((x) => ({ ...x.p, category: category.value.trim() || x.p.category })),
  });

  const renderSign = () => {
    const who = signedInAs();
    if (who && lib.owner && !mine && lib.owner.toLowerCase() !== who.toLowerCase())
      status.textContent = `This library belongs to ${lib.owner}: only they (or the list's maintainer) can update it, so the check will stop your pull request. To share your changes, give it a new id: it becomes your own library.`;
    signBox.replaceChildren(
      el('span', { textContent: who ? `Signed in to GitHub as ${who}` : 'Publishing opens a pull request on GitHub: sign in first.' }),
      el('span', { style: 'flex:1' }),
      ...(who ? [] : [el('button', { textContent: 'Sign in with GitHub', disabled: !GITHUB_CLIENT_ID, title: GITHUB_CLIENT_ID ? '' : 'not set up in this build yet', onclick: signIn })]),
    );
    goBtn.disabled = !who;
    if (who && !author.value) author.value = who;
  };
  async function signIn() {
    try {
      const d = await startSignIn();
      signBox.replaceChildren(
        el('span', {}, 'On GitHub, enter the code ', el('b', { textContent: d.user_code, style: 'font-size:16px;letter-spacing:2px' })),
        el('span', { style: 'flex:1' }),
        el('button', { textContent: 'Copy code', onclick: () => navigator.clipboard?.writeText(d.user_code) }),
        el('button', { className: 'primary', textContent: 'Open GitHub', onclick: () => openLink(d.verification_uri) }),
      );
      openLink(d.verification_uri);
      await finishSignIn(d, () => cancelled);
      renderSign();
    } catch (e) {
      if (!cancelled) status.textContent = `Sign-in: ${(e as Error).message}`;
      renderSign();
    }
  }

  goBtn.onclick = async () => {
    const out = build();
    if (!out.name || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(out.id)) return (status.textContent = 'It needs a name and an id (lowercase letters, digits, dashes).');
    if (out.id === MY_LIB) return (status.textContent = '"my-parts" is everyone\'s own library: pick an id of its own.');
    if (!/^\d+\.\d+\.\d+$/.test(out.version)) return (status.textContent = 'The version looks like 1.0.0.');
    if (!out.description || !out.author) return (status.textContent = 'Say what it is (description) and who made it (author).');
    if (!out.parts.length) return (status.textContent = 'Pick at least one part.');
    const safe = safetyOf(out);
    if (!safe.ok) return (status.textContent = `The safety check blocked it:\n${safetyReport(safe).join('\n')}`);
    goBtn.disabled = true;
    try {
      const listed = await listedVersion(out.id);
      if (listed && !newer(out.version, listed)) {
        status.textContent = `"${out.id}" is on the list at ${listed}: raise the version (e.g. ${listed.replace(/\d+$/, (n) => String(Number(n) + 1))}) or pick another id.`;
        goBtn.disabled = false;
        return;
      }
      const url = await publishLibrary(out, (s) => (status.textContent = s));
      status.replaceChildren('Sent! It goes on the list once it has been reviewed and merged: ', el('a', { href: '#', textContent: url, onclick: (e: Event) => { e.preventDefault(); openLink(url); } }));
      log(`published ${out.name} ${out.version} for review: ${url}`);
    } catch (e) {
      status.textContent = `Not published: ${(e as Error).message}`;
      goBtn.disabled = false;
    }
  };

  const grid = el('div', { className: 'pm-grid' },
    el('label', { className: 'pm-field' }, el('span', { textContent: 'Name' }), name),
    el('label', { className: 'pm-field' }, el('span', { textContent: 'Id (unique on the list)' }), id),
    el('label', { className: 'pm-field' }, el('span', { textContent: 'Version' }), version),
    el('label', { className: 'pm-field' }, el('span', { textContent: 'Author' }), author),
    el('label', { className: 'pm-field' }, el('span', { textContent: 'Category' }), category));
  back.append(el('div', { className: 'modal pm-window' },
    el('div', { className: 'modal-head' },
      el('div', { className: 'modal-title', textContent: 'Publish to the library list' }),
      el('div', { className: 'modal-sub', textContent: `Everyone can then install it from Libraries. It goes to ${LIST_REPO} as a pull request: it is safety-checked and read by a person before it's on the list.` }),
      el('button', { className: 'modal-x', textContent: '×', onclick: close })),
    el('div', { className: 'pm-body' },
      grid,
      el('label', { className: 'pm-field' }, el('span', { textContent: 'Description' }), desc),
      el('div', { className: 'pm-field' }, el('span', { textContent: 'Parts in it' }),
        ...picks.map((x) => el('label', { className: 'pm-row' }, x.box, el('span', { textContent: `${x.p.name}${x.p.glb ? ' (with 3D model)' : ''}` })))),
      signBox,
      status),
    el('div', { className: 'lib-foot' }, el('span', { style: 'flex:1' }), el('button', { textContent: 'Cancel', onclick: close }), goBtn)));
  document.body.append(back);
  back.onclick = (e) => e.target === back && close();
  // an update: suggest the next version if this one is already on the list
  if (!mine)
    listedVersion(lib.id).then((listed) => {
      if (listed && !newer(version.value.trim(), listed)) {
        version.value = listed.replace(/(\d+)$/, (n) => String(Number(n) + 1));
        console.info(`[publish] ${lib.id} is on the list at ${listed}: suggesting ${version.value}`);
      }
    }).catch(() => {});
  status.style.whiteSpace = 'pre-wrap';
  status.textContent = 'Its code and models are checked for anything unsafe before it is sent.';
  renderSign();
}
