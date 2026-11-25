// Fingerprint of the website code ("zámek 4", CODE_HASH – NAVOD.md, step B8).
//
// The check itself runs in the Build command in Cloudflare (outside the repository, so a change
// in the repository cannot switch it off). This file only holds the same calculation for Claude
// and for the tests – Cloudflare never runs it:
//
//   node scripts/code-hash.mjs <commit>     prints the fingerprint of that commit
//
// What is hashed: the list of all files of the commit (`git ls-tree -r -z --full-tree`: mode,
// type, blob id and path of every file, NUL-terminated), without the records of content files
// (content/<name>.json) and photos (static/uploads/<name>) – those may change without a new
// fingerprint. Only plain files (mode 100644) with safe names are left out; anything else under
// these folders (executable, symlink, odd name) stays in and changes the fingerprint.
// NUL-separated records (-z) keep paths exactly as they are – with spaces, tabs or newlines –
// so no file can hide from the hash behind an unusual name (awk '$4' on the quoted text output
// used to look only at the part of the path before the first space).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// One record of `git ls-tree -r -z` that does NOT count into the fingerprint.
export const EXCLUDED_RECORD_RE = /^100644 blob [0-9a-f]{40,64}[ \t](?:content\/[a-z0-9-]+[.]json|static\/uploads\/[a-z0-9][a-z0-9._-]*)$/;

// The same filter for GNU grep (-z: NUL-separated records, LC_ALL=C: byte ranges in every locale).
const GREP_FILTER = "LC_ALL=C grep -zvE '^100644 blob [0-9a-f]{40,64}[[:blank:]](content/[a-z0-9-]+[.]json|static/uploads/[a-z0-9][a-z0-9._-]*)$'";

/** Shell pipeline printing the fingerprint of `rev` (Git Bash on Windows, bash in Cloudflare). */
export function codeHashShell(rev) {
  return `git ls-tree -r -z --full-tree ${rev} | ${GREP_FILTER} | sha256sum | cut -c1-64`;
}

/** The Build command for Cloudflare (NAVOD.md B8 must contain exactly this line). */
export const BUILD_COMMAND =
  `H=$(${codeHashShell('HEAD')}); if [ "$H" != "$CODE_HASH" ]; then echo "Kód webu se změnil bez schválení (otisk $H). Nasazení zastaveno."; exit 1; fi; node build.mjs`;

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 30000 });
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} selhal: ${r.error ? r.error.message : r.stderr.toString('utf8').trim()}`);
  return r.stdout;
}

/** Fingerprint (64 hex characters) of the commit or tree `rev` in the repository at `root`. */
export function codeHash(root, rev) {
  const out = git(root, ['ls-tree', '-r', '-z', '--full-tree', rev]);
  const kept = [];
  let start = 0;
  for (let i = out.indexOf(0); i !== -1; start = i + 1, i = out.indexOf(0, start)) {
    const record = out.subarray(start, i);
    if (!EXCLUDED_RECORD_RE.test(record.toString('latin1'))) kept.push(record, Buffer.from([0]));
  }
  return createHash('sha256').update(Buffer.concat(kept)).digest('hex');
}

/** Files named wrangler.* in the root of `rev` (Cloudflare would read them before the Build command). */
export function wranglerFiles(root, rev) {
  return git(root, ['ls-tree', '-z', '--name-only', rev]).toString('utf8').split('\0').filter((n) => /^wrangler\./i.test(n));
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rev = process.argv[2] || 'HEAD';
  const wrangler = wranglerFiles(root, rev);
  if (wrangler.length) {
    console.error(`V kořeni ${rev} je ${wrangler.join(', ')} – Cloudflare by ho četl dřív než Build command. Otisk nepočítám.`);
    process.exitCode = 1;
  } else {
    console.log(codeHash(root, rev));
  }
}
