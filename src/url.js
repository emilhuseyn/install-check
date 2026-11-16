// npmjs.com/package/<name>[/v/<version>] and "name@version" specs.

export function parsePackageUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)npmjs\.com$/.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'package' || parts.length < 2) return null;
  let i = 1;
  let name = parts[i++];
  if (name.startsWith('@')) {
    if (!parts[i]) return null;
    name = `${name}/${parts[i++]}`;
  }
  const version = parts[i] === 'v' && parts[i + 1] ? parts[i + 1] : undefined;
  return { name, version };
}

export function parseSpec(text) {
  const s = String(text || '').trim().replace(/^npm\s+(i|install|add)\s+/, '');
  if (!s) return null;
  const fromUrl = parsePackageUrl(s);
  if (fromUrl) return fromUrl;
  const at = s.lastIndexOf('@');
  if (at > 0) return { name: s.slice(0, at), version: s.slice(at + 1) || undefined };
  return { name: s, version: undefined };
}
