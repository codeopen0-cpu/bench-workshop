// Publishing a library to the shared list from the app: sign in to GitHub (device sign-in: the app
// shows a code, you enter it on github.com; the app never sees your password), then the library
// goes in as a pull request to the list's repo, as a readable folder (library.json, device.js,
// sketch/*.js, models/*.glb). The list's maintainers read it and merge it; GitHub then packs it
// and it shows up in everyone's Libraries menu. The safety check runs first and blocks bad ones.
import type { Library } from './format';
import { safetyOf, safetyReport } from './store';

/** The shared list's repo, and the GitHub OAuth app the app signs in with (device flow; the client
 *  id is public by design, there is no secret). */
export const LIST_REPO = 'codeopen0-cpu/bench-workshop-libraries';
export const GITHUB_CLIENT_ID = 'Ov23li2nUYtTSVQzpnmv'; // the "Bench Workshop" OAuth app on codeopen0-cpu (device flow on)

const inTauri = () => '__TAURI_INTERNALS__' in window;
let token: string | null = null; // kept for this session only, never stored
let login: string | null = null;
export const signedInAs = () => login;
export const signOut = () => { token = null; login = null; };

/** github.com's sign-in endpoints (no CORS): from the native side in the app, through the dev server's proxy in a browser */
async function loginPost(path: string, body: Record<string, string>) {
  const init = { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let r: Response;
  if (inTauri()) {
    const { fetch: tfetch } = await import('@tauri-apps/plugin-http');
    r = await tfetch(`https://github.com/login/${path}`, init);
  } else r = await fetch(`/gh-login/${path}`, init);
  if (!r.ok) throw new Error(`GitHub sign-in answered ${r.status}`);
  return r.json();
}

export interface DeviceCode { user_code: string; verification_uri: string; device_code: string; interval: number; expires_in: number }

/** Step 1: a code to enter at github.com/login/device */
export async function startSignIn(): Promise<DeviceCode> {
  if (!GITHUB_CLIENT_ID) throw new Error("publishing isn't set up in this build yet (no GitHub app id)");
  const d = await loginPost('device/code', { client_id: GITHUB_CLIENT_ID, scope: 'public_repo' });
  if (!d.device_code) throw new Error(d.error_description ?? 'GitHub gave no sign-in code');
  return d;
}
/** Step 2: wait until it's entered (or it runs out). */
export async function finishSignIn(d: DeviceCode, cancelled: () => boolean) {
  let wait = Math.max(5, d.interval) * 1000;
  const until = Date.now() + d.expires_in * 1000;
  while (Date.now() < until && !cancelled()) {
    await new Promise((r) => setTimeout(r, wait));
    const t = await loginPost('oauth/access_token', { client_id: GITHUB_CLIENT_ID, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (t.access_token) {
      token = t.access_token;
      login = (await gh('GET', '/user')).login;
      console.info(`[publish] signed in to GitHub as ${login}`);
      return login!;
    }
    if (t.error === 'slow_down') wait += 5000;
    else if (t.error && t.error !== 'authorization_pending') throw new Error(t.error_description ?? t.error);
  }
  throw new Error(cancelled() ? 'cancelled' : 'the sign-in code ran out: try again');
}

async function gh(method: string, path: string, body?: any) {
  if (!token) throw new Error('not signed in');
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`GitHub: ${method} ${path} answered ${r.status}: ${(() => { try { return JSON.parse(text).message; } catch { return text.slice(0, 200); } })()}`);
  return text ? JSON.parse(text) : null;
}

/** The library as the files of its folder in the list's repo (the readable form people review). */
export function libraryFiles(lib: Library): { path: string; text?: string; b64?: string }[] {
  const out: { path: string; text?: string; b64?: string }[] = [];
  const meta: any = JSON.parse(JSON.stringify(lib));
  if (lib.code) {
    meta.code = 'device.js';
    out.push({ path: 'device.js', text: lib.code });
  }
  for (const [name, f] of Object.entries(lib.sketch ?? {})) {
    const file = `sketch/${name.replace(/\.hpp?$/, '')}${name.endsWith('.hpp') ? '-hpp' : ''}.js`;
    meta.sketch[name] = { classes: f.classes ?? [], file };
    out.push({ path: file, text: f.code });
  }
  for (const p of meta.parts) {
    if (p.glb) {
      out.push({ path: `models/${p.id}.glb`, b64: p.glb });
      p.glbFile = `models/${p.id}.glb`;
      delete p.glb;
    }
  }
  (meta.examples ?? []).forEach((ex: any, i: number) => {
    const file = `examples/${(ex.name || `example-${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.bench`;
    out.push({ path: file, text: JSON.stringify(ex.project, null, 1) });
    ex.file = file;
    delete ex.project;
  });
  out.unshift({ path: 'library.json', text: JSON.stringify(meta, null, 2) + '\n' });
  return out;
}

/** What's on the list now for this id (to require a newer version). */
export async function listedVersion(id: string): Promise<string | null> {
  const r = await fetch(`https://raw.githubusercontent.com/${LIST_REPO}/main/index.json`, { cache: 'no-cache' });
  if (!r.ok) return null;
  return (await r.json()).libraries?.find((e: any) => e.id === id)?.version ?? null;
}

/** Publish: a pull request adding/updating src/<id>/ in the list's repo. Returns its address. */
export async function publishLibrary(lib: Library, progress: (step: string) => void): Promise<string> {
  const safe = safetyOf(lib);
  if (!safe.ok) throw new Error(`the safety check blocked it: ${safetyReport(safe).filter((l) => l.startsWith('BLOCKED')).join('; ')}`);
  if (!login) throw new Error('not signed in');
  const [owner, name] = LIST_REPO.split('/');
  const upstream = await gh('GET', `/repos/${LIST_REPO}`);
  const mainSha = (await gh('GET', `/repos/${LIST_REPO}/git/ref/heads/${upstream.default_branch}`)).object.sha;
  const baseTree = (await gh('GET', `/repos/${LIST_REPO}/git/commits/${mainSha}`)).tree.sha;
  // your own copy of the list (a fork) to put the change in; the list's owner works in a branch
  let repo = LIST_REPO;
  if (login.toLowerCase() !== owner.toLowerCase()) {
    progress('making your copy of the list (a fork)...');
    const fork = await gh('POST', `/repos/${LIST_REPO}/forks`, { default_branch_only: true });
    repo = fork.full_name;
    for (let i = 0; i < 20; i++) {
      try { await gh('GET', `/repos/${repo}/git/ref/heads/${upstream.default_branch}`); break; } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
  }
  progress('uploading its files...');
  const tree = [];
  for (const f of libraryFiles(lib)) {
    const blob = await gh('POST', `/repos/${repo}/git/blobs`, f.b64 ? { content: f.b64, encoding: 'base64' } : { content: f.text, encoding: 'utf-8' });
    tree.push({ path: `src/${lib.id}/${f.path}`, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh('POST', `/repos/${repo}/git/trees`, { base_tree: baseTree, tree });
  const commit = await gh('POST', `/repos/${repo}/git/commits`, { message: `${lib.name} ${lib.version}`, tree: newTree.sha, parents: [mainSha] });
  const branch = `library/${lib.id}-${lib.version}-${Date.now().toString(36)}`;
  await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  progress('opening the pull request...');
  const warns = safetyReport(safe);
  const pr = await gh('POST', `/repos/${LIST_REPO}/pulls`, {
    title: `${lib.name} ${lib.version}`,
    head: repo === LIST_REPO ? branch : `${login}:${branch}`,
    base: upstream.default_branch,
    body: [
      `**${lib.name}** ${lib.version} by ${lib.author}`, '', lib.description, '',
      `Parts: ${lib.parts.map((p) => p.name).join(', ')}`,
      lib.code ? `Device code: \`src/${lib.id}/device.js\` (${(lib.code.length / 1024).toFixed(1)} KB)` : 'No device code.',
      ...Object.keys(lib.sketch ?? {}).map((s) => `Sketch library: ${s}`), '',
      `App safety check: passed${warns.length ? `, with notes:\n${warns.map((w) => `- ${w}`).join('\n')}` : '.'}`, '',
      '_Published from Bench Workshop._',
    ].join('\n'),
    maintainer_can_modify: true,
  });
  console.info(`[publish] ${lib.id} ${lib.version}: pull request ${pr.html_url}`);
  void name;
  return pr.html_url;
}
