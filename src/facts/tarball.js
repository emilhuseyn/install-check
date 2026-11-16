// Unpacks an npm tarball in the browser (gzip + ustar) and builds the compact input for the cloud
// deep check: install-time code and what changed since the previous version.

import { fetchBytes } from './registry.js';

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const dec = new TextDecoder();
const str = (b, o, n) => dec.decode(b.subarray(o, o + n)).replace(/\0.*$/s, '');

export function untar(buf) {
  const files = new Map();
  let off = 0;
  let longName = null;
  let paxPath = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((x) => x === 0)) break;
    let name = str(header, 0, 100);
    const size = parseInt(str(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = str(body, 0, body.length);
      continue;
    }
    if (type === 'x') {
      const m = /\d+ path=([^\n]+)\n/.exec(dec.decode(body));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue;
    const path = (paxPath || longName || name).replace(/^[^/]+\//, '');
    longName = null;
    paxPath = null;
    if (type === '0' || type === '\0' || type === '7') files.set(path, body.slice());
  }
  return files;
}

async function sha256(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(h.slice(0, 8), (x) => x.toString(16).padStart(2, '0')).join('');
}

function isText(bytes) {
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

export async function loadTarball(url, maxBytes) {
  const gz = await fetchBytes(url, maxBytes);
  const files = untar(await gunzip(gz));
  const index = new Map();
  for (const [path, bytes] of files) index.set(path, { size: bytes.length, hash: await sha256(bytes), text: isText(bytes) });
  return { files, index };
}

// Files an install hook refers to: `node install.js`, `node ./scripts/postinstall.cjs`, `sh x.sh`.
export function scriptTargets(hooks, files) {
  const targets = new Set();
  for (const cmd of Object.values(hooks || {})) {
    for (const tok of String(cmd).split(/[\s;&|(){}]+/)) {
      const t = tok.replace(/^["'`]+|["'`]+$/g, '').replace(/^\.\//, '');
      if (files.has(t)) targets.add(t);
      else if (files.has(`${t}.js`)) targets.add(`${t}.js`);
    }
  }
  if (files.has('binding.gyp')) targets.add('binding.gyp');
  return [...targets];
}

function clip(text, n) {
  return text.length > n ? `${text.slice(0, n)}\n[... ${text.length - n} more characters not sent]` : text;
}

function depsDiff(a = {}, b = {}) {
  const added = Object.keys(b).filter((k) => !(k in a)).map((k) => `${k}@${b[k]}`);
  const removed = Object.keys(a).filter((k) => !(k in b));
  const changed = Object.keys(b).filter((k) => k in a && a[k] !== b[k]).map((k) => `${k}: ${a[k]} -> ${b[k]}`);
  return { added, removed, changed };
}

export async function buildDeepInput(facts, prevFacts, cfg) {
  const maxBytes = (cfg.deepMaxTarballMb || 15) * 1048576;
  const budget = cfg.deepMaxChars || 60000;
  const cur = await loadTarball(facts.tarball, maxBytes);
  const prev = prevFacts?.tarball ? await loadTarball(prevFacts.tarball, maxBytes).catch(() => null) : null;

  const pkgCur = JSON.parse(dec.decode(cur.files.get('package.json') || new Uint8Array()) || '{}');
  const pkgPrev = prev ? JSON.parse(dec.decode(prev.files.get('package.json') || new Uint8Array()) || '{}') : null;

  const targets = scriptTargets(facts.scripts.hooks, cur.files);
  const sections = [];
  let used = 0;
  const per = Math.floor(budget / Math.max(2, targets.length + 2));
  for (const t of targets) {
    const body = clip(dec.decode(cur.files.get(t)), per);
    used += body.length;
    sections.push({ file: t, role: 'install-time', content: body });
  }

  const diff = { added: [], removed: [], changed: [] };
  if (prev) {
    for (const [p, meta] of cur.index) {
      const old = prev.index.get(p);
      if (!old) diff.added.push({ path: p, size: meta.size });
      else if (old.hash !== meta.hash) diff.changed.push({ path: p, size: meta.size, before: old.size });
    }
    for (const [p, meta] of prev.index) if (!cur.index.has(p)) diff.removed.push({ path: p, size: meta.size });
    const interesting = [...diff.added, ...diff.changed]
      .filter((x) => cur.index.get(x.path)?.text && x.size < 200000 && !targets.includes(x.path) && x.path !== 'package.json')
      .sort((a, b) => a.size - b.size)
      .slice(0, 6);
    for (const x of interesting) {
      if (used > budget * 0.8) break;
      const body = clip(dec.decode(cur.files.get(x.path)), Math.min(per, budget - used));
      used += body.length;
      sections.push({ file: x.path, role: diff.added.includes(x) ? 'added since previous version' : 'changed since previous version', content: body });
    }
  }

  return {
    package: `${facts.name}@${facts.version}`,
    previous: prev ? prevFacts.version : null,
    installHooks: facts.scripts.hooks,
    fileCount: cur.index.size,
    binaryFiles: [...cur.index].filter(([, m]) => !m.text).map(([p, m]) => `${p} (${m.size} B)`).slice(0, 40),
    dependencies: pkgPrev ? depsDiff(pkgPrev.dependencies, pkgCur.dependencies) : { current: Object.keys(pkgCur.dependencies || {}) },
    scriptsChanged: pkgPrev ? JSON.stringify(pkgPrev.scripts || {}) !== JSON.stringify(pkgCur.scripts || {}) : null,
    fileDiff: prev
      ? {
          added: diff.added.slice(0, 60).map((x) => `${x.path} (${x.size} B)`),
          removed: diff.removed.slice(0, 60).map((x) => x.path),
          changed: diff.changed.slice(0, 60).map((x) => `${x.path} (${x.before} -> ${x.size} B)`),
          totals: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length }
        }
      : null,
    files: sections
  };
}
