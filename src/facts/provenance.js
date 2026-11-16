// Reads the npm attestation bundle: what the provenance statement names, and what the Sigstore
// certificate and Rekor entry around it say.

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64ToText(b64) {
  return new TextDecoder().decode(b64ToBytes(b64));
}

// Minimal DER walk: enough to read the validity window and SAN URI of a Fulcio certificate.
function readDer(bytes, start = 0, end = bytes.length, out = []) {
  let i = start;
  while (i < end) {
    const tag = bytes[i++];
    let len = bytes[i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | bytes[i++];
    }
    const node = { tag, start: i, len };
    out.push(node);
    const constructed = (tag & 0x20) !== 0;
    if (constructed) readDer(bytes, i, i + len, out);
    else if (tag === 0x04 && len > 2 && bytes[i] === 0x30) {
      try {
        readDer(bytes, i, i + len, out);
      } catch {
        /* not nested DER */
      }
    }
    i += len;
  }
  return out;
}

function derTime(bytes, node) {
  const s = new TextDecoder().decode(bytes.subarray(node.start, node.start + node.len));
  if (node.tag === 0x17) {
    const yy = +s.slice(0, 2);
    const y = yy >= 50 ? 1900 + yy : 2000 + yy;
    return new Date(Date.UTC(y, +s.slice(2, 4) - 1, +s.slice(4, 6), +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
  }
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)));
}

export function parseCertificate(der) {
  const nodes = readDer(der);
  const times = nodes.filter((n) => n.tag === 0x17 || n.tag === 0x18).slice(0, 2);
  const uris = nodes
    .filter((n) => n.tag === 0x86)
    .map((n) => new TextDecoder().decode(der.subarray(n.start, n.start + n.len)));
  if (times.length < 2) return null;
  const notBefore = derTime(der, times[0]);
  const notAfter = derTime(der, times[1]);
  return {
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    minutes: Math.round((notAfter - notBefore) / 60000),
    san: uris[0] || null
  };
}

function certFromBundle(bundle) {
  const vm = bundle?.verificationMaterial || {};
  const raw = vm.certificate?.rawBytes || vm.x509CertificateChain?.certificates?.[0]?.rawBytes;
  if (!raw) return null;
  try {
    return parseCertificate(b64ToBytes(raw));
  } catch {
    return null;
  }
}

function tlogFromBundle(bundle) {
  const e = bundle?.verificationMaterial?.tlogEntries?.[0];
  if (!e) return null;
  return {
    logIndex: Number(e.logIndex),
    integratedTime: e.integratedTime ? new Date(Number(e.integratedTime) * 1000).toISOString() : null
  };
}

function refKind(ref) {
  if (!ref) return 'unknown';
  if (ref.startsWith('refs/heads/')) return 'branch';
  if (ref.startsWith('refs/tags/')) return 'tag';
  if (ref.startsWith('refs/pull/')) return 'pull';
  return 'other';
}

function repoFromUri(uri) {
  const m = /github\.com\/([^/]+)\/([^/@]+?)(?:\.git)?(?:@|$|\/)/.exec(uri || '');
  return m ? `${m[1]}/${m[2]}` : null;
}

export function parseProvenance(attResponse) {
  const list = attResponse?.attestations || [];
  const prov = list.find((a) => /slsa\.dev\/provenance/.test(a.predicateType));
  const publish = list.find((a) => /npm\/attestation\/.*publish/.test(a.predicateType));
  if (!prov) return { provenance: null, publishAttestation: !!publish };

  const bundle = prov.bundle;
  const statement = JSON.parse(b64ToText(bundle.dsseEnvelope.payload));
  const pred = statement.predicate || {};
  let repo = null;
  let commit = null;
  let ref = null;
  let workflowPath = null;
  let builderId = null;
  let runUrl = null;
  let slsa = null;

  if (pred.buildDefinition) {
    slsa = 'v1';
    const wf = pred.buildDefinition.externalParameters?.workflow || {};
    repo = repoFromUri(wf.repository);
    ref = wf.ref || null;
    workflowPath = wf.path || null;
    const dep = (pred.buildDefinition.resolvedDependencies || []).find((d) => d.digest?.gitCommit);
    commit = dep?.digest?.gitCommit || null;
    if (!repo && dep) repo = repoFromUri(dep.uri);
    builderId = pred.runDetails?.builder?.id || null;
    runUrl = pred.runDetails?.metadata?.invocationId || null;
  } else if (pred.invocation) {
    slsa = 'v0.2';
    const cs = pred.invocation.configSource || {};
    repo = repoFromUri(cs.uri);
    commit = cs.digest?.sha1 || null;
    workflowPath = cs.entryPoint || null;
    const m = /@(refs\/[^\s]+)$/.exec(cs.uri || '');
    ref = m ? m[1] : null;
    builderId = pred.builder?.id || null;
  }

  return {
    publishAttestation: !!publish,
    provenance: {
      slsa,
      predicateType: prov.predicateType,
      subject: statement.subject?.[0]?.name || null,
      repo,
      commit,
      ref,
      refKind: refKind(ref),
      workflowPath,
      builderId,
      runUrl,
      githubHosted: !!(builderId && /github\.com\/actions\/runner\/github-hosted/.test(builderId)),
      cert: certFromBundle(bundle),
      tlog: tlogFromBundle(bundle)
    }
  };
}
