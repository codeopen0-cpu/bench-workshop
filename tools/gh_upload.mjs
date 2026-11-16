// Uploads a folder to a GitHub repo as ONE commit, through the GitHub API (no local git: the
// project folder never becomes a git repo). Uses the gh CLI's login; the token is never printed.
//   node tools/gh_upload.mjs <owner/repo> <folder> "<commit message>" [branch]
// Files in the repo that aren't in the folder are left alone (it adds and updates only).
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const [repo, folder, message, branch = 'main'] = process.argv.slice(2);
if (!repo || !folder || !message) {
  console.error('usage: node tools/gh_upload.mjs <owner/repo> <folder> "<message>" [branch]');
  process.exit(2);
}
const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, path, body) => {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bench-workshop-upload' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    // GitHub's "slow down" (about 80 new things a minute): wait as long as it says, then try again
    if ((r.status === 403 || r.status === 429) && /rate limit/i.test(text) && attempt < 8) {
      const wait = Number(r.headers.get('retry-after')) || 60;
      console.log(`  (GitHub says slow down: waiting ${wait} s)`);
      await sleep(wait * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
};

const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    if (n === 'node_modules' || n === '.git') continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(folder);

const ref = await api('GET', `/git/ref/heads/${branch}`);
const parent = ref.object.sha;
const base = await api('GET', `/git/commits/${parent}`);
const tree = [];
for (const [k, f] of files.entries()) {
  if (files.length > 60) {
    await sleep(800); // (many files: under GitHub's pace, about 75 a minute)
    if (k % 25 === 0) console.log(`  ${k} / ${files.length} files sent`);
  }
  const blob = await api('POST', '/git/blobs', { content: readFileSync(f).toString('base64'), encoding: 'base64' });
  tree.push({ path: relative(folder, f).split('\\').join('/'), mode: '100644', type: 'blob', sha: blob.sha });
}
const newTree = await api('POST', '/git/trees', { base_tree: base.tree.sha, tree });
const commit = await api('POST', '/git/commits', { message, tree: newTree.sha, parents: [parent] });
await api('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha });
console.log(`${repo}@${branch}: ${files.length} files in one commit ${commit.sha.slice(0, 7)}`);
for (const t of tree) console.log(`  ${t.path}`);
