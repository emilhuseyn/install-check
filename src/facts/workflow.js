// Reads the workflow file named by the provenance statement, at the attested commit, and lists every
// `uses:` reference in it. Same categories as the measurement: GitHub-owned, same-owner, third-party.

const RAW = 'https://raw.githubusercontent.com';
const GITHUB_OWNERS = new Set(['actions', 'github']);

export function parseUses(yamlText, repoOwner) {
  const refs = [];
  const lines = yamlText.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const m = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s#]+)['"]?/.exec(line);
    if (!m) return;
    const uses = m[1];
    const entry = { uses, line: idx + 1 };
    if (uses.startsWith('./') || uses.startsWith('.\\')) {
      Object.assign(entry, { kind: 'local', pinned: true, owner: repoOwner });
    } else if (uses.startsWith('docker://')) {
      Object.assign(entry, { kind: 'docker', pinned: /@sha256:[0-9a-f]{64}$/.test(uses), owner: null });
    } else {
      const at = uses.lastIndexOf('@');
      const path = at > 0 ? uses.slice(0, at) : uses;
      const ref = at > 0 ? uses.slice(at + 1) : '';
      const owner = path.split('/')[0];
      const pinned = /^[0-9a-f]{40}$/i.test(ref);
      let kind = 'third-party';
      if (GITHUB_OWNERS.has(owner.toLowerCase())) kind = 'github';
      else if (repoOwner && owner.toLowerCase() === repoOwner.toLowerCase()) kind = 'same-owner';
      Object.assign(entry, { kind, owner, path, ref, pinned, reusableWorkflow: /\.ya?ml$/.test(path) });
    }
    refs.push(entry);
  });
  return refs;
}

export function summarizeRefs(refs) {
  const remote = refs.filter((r) => r.kind !== 'local');
  const mutable = remote.filter((r) => !r.pinned);
  return {
    total: remote.length,
    pinned: remote.length - mutable.length,
    mutable: mutable.length,
    mutableGithub: mutable.filter((r) => r.kind === 'github').length,
    mutableSameOwner: mutable.filter((r) => r.kind === 'same-owner').length,
    mutableThirdParty: mutable.filter((r) => r.kind === 'third-party' || r.kind === 'docker').length
  };
}

async function rawText(repo, commit, path) {
  const res = await fetch(`${RAW}/${repo}/${commit}/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`raw ${path} -> HTTP ${res.status}`);
  return res.text();
}

export async function inspectWorkflow(prov) {
  if (!prov?.repo || !prov.commit || !prov.workflowPath) return null;
  const owner = prov.repo.split('/')[0];
  const out = { repo: prov.repo, commit: prov.commit, path: prov.workflowPath, fetched: false };
  try {
    const [yaml, lock] = await Promise.all([
      rawText(prov.repo, prov.commit, prov.workflowPath),
      rawText(prov.repo, prov.commit, '.github/workflows/actions.lock')
    ]);
    out.lockfile = lock !== null;
    if (yaml !== null) {
      out.fetched = true;
      out.refs = parseUses(yaml, owner);
      out.counts = summarizeRefs(out.refs);
    }
  } catch (e) {
    out.error = String(e.message || e);
  }
  return out;
}
