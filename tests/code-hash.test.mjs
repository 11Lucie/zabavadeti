// Tests of the code fingerprint (CODE_HASH, "zámek 4", NAVOD.md B8): the shell pipeline in the
// Cloudflare Build command and scripts/code-hash.mjs must compute the same value, and no file
// may slip out of the fingerprint because of an unusual name (spaces, tabs, newlines, quotes).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeHash, codeHashShell, BUILD_COMMAND, EXCLUDED_RECORD_RE, wranglerFiles } from '../scripts/code-hash.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, input, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString('utf8').trim();
}

// bash with GNU grep: Git Bash on Windows (never WSL's bash.exe), bash elsewhere. null = skip.
function findBash() {
  if (process.platform !== 'win32') return spawnSync('bash', ['-c', 'true']).status === 0 ? 'bash' : null;
  const exec = spawnSync('git', ['--exec-path'], { windowsHide: true }).stdout?.toString().trim();
  if (!exec) return null;
  const bash = resolve(exec, '..', '..', '..', 'bin', 'bash.exe');
  return existsSync(bash) ? bash : null;
}

async function repoWith(paths) {
  const dir = await mkdtemp(join(tmpdir(), 'zabavadeti-hash-'));
  git(dir, ['init', '-q']);
  const blob = git(dir, ['hash-object', '-w', '--stdin'], 'obsah\n');
  const info = paths.map(([mode, p]) => `${mode} ${blob}\t${p}\0`).join('');
  // Git for Windows silently skips names with control characters unless protectNTFS is off.
  git(dir, ['-c', 'core.protectNTFS=false', 'update-index', '-z', '--add', '--index-info'], info);
  const tree = git(dir, ['-c', 'core.protectNTFS=false', 'write-tree']);
  const names = git(dir, ['ls-tree', '-r', '-z', '--name-only', tree]).split('\0').filter(Boolean);
  assert.deepEqual(names.sort(), paths.map(([, p]) => p).sort(), 'všechny soubory jsou ve stromu');
  return { dir, tree };
}

describe('otisk kódu (CODE_HASH)', () => {
  const BASE = [
    ['100644', 'build.mjs'],
    ['100644', 'content/uvod.json'],
    ['100644', 'static/uploads/oslava-2026.jpg'],
  ];

  test('změna textů a fotek otisk nemění, cokoli jiného ano – i soubor s mezerou, tabulátorem nebo novým řádkem v názvu', async () => {
    const base = await repoWith(BASE);
    const more = await repoWith([...BASE, ['100644', 'content/kontakt.json'], ['100644', 'static/uploads/nova.jpg']]);
    const h = codeHash(base.dir, base.tree);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(codeHash(more.dir, more.tree), h, 'nové texty a fotky otisk nemění');
    const sneaky = [
      ['100644', 'content/uvod.json evil.js'], // awk '$4' viděl jen „content/uvod.json“
      ['100644', 'static/uploads/a.jpg x/functions/api/x.js'],
      ['100644', 'content/x.json\tfunctions/api/evil.js'],
      ['100644', 'static/uploads/a.jpg\nbuild.mjs'],
      ['100644', 'content/"q".json'],
      ['100644', 'content/sub/x.json'],
      ['100644', 'content/Velka.json'],
      ['100755', 'static/uploads/spustitelny.jpg'],
      ['120000', 'static/uploads/odkaz.jpg'],
      ['100644', 'functions/api/evil.js'],
      ['100644', 'NAVOD.md'],
    ];
    for (const extra of sneaky) {
      const r = await repoWith([...BASE, extra]);
      assert.notEqual(codeHash(r.dir, r.tree), h, JSON.stringify(extra));
      await rm(r.dir, { recursive: true, force: true });
    }
    await rm(base.dir, { recursive: true, force: true });
    await rm(more.dir, { recursive: true, force: true });
  });

  test('příkaz pro Git Bash / Cloudflare spočítá stejný otisk jako scripts/code-hash.mjs', async (t) => {
    const bash = findBash();
    if (!bash) return t.skip('bash s GNU grep tu není');
    const r = await repoWith([...BASE, ['100644', 'content/uvod.json evil.js'], ['100644', 'content/x.json\tfunctions/evil.js'],
      ['100644', 'static/uploads/a.jpg\nbuild.mjs'], ['100755', 'static/uploads/b.jpg'], ['100644', 'content/kontakt.json']]);
    const sh = spawnSync(bash, ['-c', codeHashShell(r.tree)], { cwd: r.dir, windowsHide: true });
    assert.equal(sh.status, 0, String(sh.stderr));
    assert.equal(sh.stdout.toString().trim(), codeHash(r.dir, r.tree));
    // The Build command: same value, a wrong CODE_HASH stops the deployment before node build.mjs.
    const build = (codeHashValue) => spawnSync(bash, ['-c', BUILD_COMMAND.replace(' HEAD ', ` ${r.tree} `).replace('node build.mjs', 'echo BUILD')],
      { cwd: r.dir, windowsHide: true, env: { ...process.env, CODE_HASH: codeHashValue } });
    const ok = build(codeHash(r.dir, r.tree));
    assert.equal(ok.status, 0);
    assert.match(ok.stdout.toString(), /BUILD/);
    const bad = build('0'.repeat(64));
    assert.equal(bad.status, 1);
    assert.ok(!/BUILD/.test(bad.stdout.toString()));
    assert.match(bad.stdout.toString(), /Nasazení zastaveno/);
    await rm(r.dir, { recursive: true, force: true });
  });

  test('vynechávají se jen obyčejné soubory textů a fotek', () => {
    const sha = 'a'.repeat(40);
    assert.ok(EXCLUDED_RECORD_RE.test(`100644 blob ${sha}\tcontent/uvod.json`));
    assert.ok(EXCLUDED_RECORD_RE.test(`100644 blob ${sha}\tstatic/uploads/oslava-2026.jpg`));
    for (const rec of [`100755 blob ${sha}\tcontent/uvod.json`, `120000 blob ${sha}\tstatic/uploads/a.jpg`, `160000 commit ${sha}\tcontent/x.json`,
      `100644 blob ${sha}\tcontent/uvod.json x`, `100644 blob ${sha}\tstatic/uploads/a/b.jpg`, `100644 blob ${sha}\tbuild.mjs`]) {
      assert.ok(!EXCLUDED_RECORD_RE.test(rec), rec);
    }
  });

  test('návod a README uvádějí přesně tentýž výpočet (žádné awk)', () => {
    const navod = readFileSync(join(ROOT, 'NAVOD.md'), 'utf8');
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.ok(navod.includes(BUILD_COMMAND), 'NAVOD.md B8: Build command');
    for (const [name, text] of [['NAVOD.md', navod], ['README.md', readme]]) {
      assert.ok(text.includes(codeHashShell('<commit>')) || text.includes(codeHashShell('origin/main')), `${name}: výpočet otisku`);
      assert.ok(!/ls-tree[^\n]*\| *awk/.test(text), `${name}: starý výpočet přes awk`);
    }
  });

  test('v repozitáři není wrangler.* (Cloudflare by ho četl dřív než Build command)', () => {
    assert.deepEqual(wranglerFiles(ROOT, 'HEAD'), []);
  });
});
