// Safe reading of inputs from the repository (content/*.json, headers/*.txt, static/).
//
// A git checkout on Linux (Cloudflare Pages) creates real symbolic links from commits with
// mode 120000. Following such a link would let a commit read files from outside the
// repository (e.g. from the build machine). Every path component under the project root is
// therefore checked with lstat: no symlinks, only directories and regular files, and a size
// limit for files.

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Checks root/relPath component by component.
 * Returns { ok: true, stat } or { ok: false, reason: 'missing' | 'symlink' | 'notfile' | 'notdir' }.
 * expect: 'file' | 'dir'.
 */
export async function inspectPath(root, relPath, expect = 'file') {
  const parts = relPath.split('/').filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let st;
    try {
      st = await lstat(current);
    } catch {
      return { ok: false, reason: 'missing' };
    }
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    const last = i === parts.length - 1;
    if (!last && !st.isDirectory()) return { ok: false, reason: 'notdir' };
    if (last) {
      if (expect === 'dir' && !st.isDirectory()) return { ok: false, reason: 'notdir' };
      if (expect === 'file' && !st.isFile()) return { ok: false, reason: 'notfile' };
      return { ok: true, stat: st };
    }
  }
  return { ok: false, reason: 'missing' };
}

/**
 * Reads root/relPath as UTF-8 text when it is a regular file (no symlink anywhere on the
 * path) of at most maxBytes. Returns { ok: true, text } or { ok: false, reason }
 * where reason is 'missing' | 'symlink' | 'notfile' | 'notdir' | 'toolarge'.
 */
export async function readRegularFile(root, relPath, maxBytes) {
  const info = await inspectPath(root, relPath, 'file');
  if (!info.ok) return info;
  if (info.stat.size > maxBytes) return { ok: false, reason: 'toolarge' };
  const text = await readFile(join(root, ...relPath.split('/')), 'utf8');
  if (Buffer.byteLength(text) > maxBytes) return { ok: false, reason: 'toolarge' };
  return { ok: true, text };
}

/** Czech explanation of a failed readRegularFile/inspectPath. */
export function reasonText(reason, maxBytes) {
  switch (reason) {
    case 'symlink':
      return 'Je to zástupce (symbolický odkaz) – z bezpečnostních důvodů se nečte.';
    case 'notfile':
      return 'Není to běžný soubor.';
    case 'notdir':
      return 'Není to běžná složka.';
    case 'toolarge':
      return `Soubor je příliš velký (povoleno nejvýše ${Math.round(maxBytes / 1024)} kB).`;
    default:
      return 'Soubor chybí nebo ho nejde přečíst.';
  }
}
