const REGISTRY = 'https://registry.npmjs.org';

export function escapeName(name) {
  return name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
}

async function getJson(url, init = {}) {
  const res = await fetch(url, init);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export function fetchAbbreviated(name) {
  return getJson(`${REGISTRY}/${escapeName(name)}`, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' }
  });
}

export function fetchManifest(name, version) {
  return getJson(`${REGISTRY}/${escapeName(name)}/${encodeURIComponent(version)}`);
}

export function fetchAttestations(name, version) {
  return getJson(`${REGISTRY}/-/npm/v1/attestations/${escapeName(name)}@${encodeURIComponent(version)}`);
}

// The full packument carries publish times; for very large packages it can be tens of MB,
// so stop reading after maxBytes and continue without dates.
export async function fetchTimes(name, maxBytes) {
  const res = await fetch(`${REGISTRY}/${escapeName(name)}`);
  if (!res.ok || !res.body) return null;
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    res.body.cancel();
    return null;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const doc = JSON.parse(new TextDecoder().decode(buf));
  return doc.time || null;
}

export async function fetchBytes(url, maxBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    res.body?.cancel();
    throw new Error(`tarball is ${(declared / 1048576).toFixed(1)} MB, above the ${(maxBytes / 1048576).toFixed(0)} MB limit`);
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) throw new Error('tarball above the size limit');
  return new Uint8Array(ab);
}
