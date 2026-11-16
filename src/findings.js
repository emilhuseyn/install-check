// Turns collected facts into signal cards: what each green signal certifies, what it leaves out,
// and the measured context behind that statement. Deterministic; no model involved.

import { evidenceList } from './evidence.js';

const PRE_TAGS = /^(next|beta|alpha|rc|canary|preview|experimental|dev|insiders|nightly|edge)$/i;

const short = (sha) => (sha ? sha.slice(0, 7) : '?');
const day = (iso) => (iso ? iso.slice(0, 10) : 'unknown date');

export function classifyTag(t, staleDays) {
  if (!t.olderThanLatest) return 'ahead';
  if (t.daysBeforeLatest !== null && t.daysBeforeLatest < 0) return 'newer-build';
  if (t.daysBeforeLatest !== null && t.daysBeforeLatest < staleDays) return 'recent-older';
  return 'stale';
}

function provenanceCard(f) {
  const p = f.provenance;
  if (!p) {
    return {
      id: 'provenance',
      title: 'Provenance',
      level: 'note',
      headline: `No provenance attestation for ${f.name}@${f.version}`,
      certifies: [],
      doesNot: ['Nothing on the registry links this tarball to a source commit or to a build.'],
      items: f.publishAttestation ? ['npm signed a publish attestation (who published), but no build provenance.'] : [],
      evidence: evidenceList(['prov_adoption'])
    };
  }
  const branch = p.refKind === 'branch' ? p.ref.replace('refs/heads/', '') : null;
  const certifies = [
    `The tarball digest matches a statement signed during a build of ${p.repo} at commit ${short(p.commit)}.`,
    `The build ran ${p.workflowPath || 'a workflow'}${p.ref ? `, triggered from ${p.ref}` : ''}.`
  ];
  const doesNot = [
    branch
      ? `That this commit was tagged or reviewed as a release: it was built from the branch "${branch}".`
      : 'That the commit was reviewed.',
    'What the build pulled in while it ran (see Workflow inputs).',
    'That the code is safe to install.'
  ];
  if (!p.githubHosted) doesNot.unshift('The build machine: the builder is not a GitHub-hosted runner.');
  const items = [];
  if (f.publisher) {
    items.push(
      f.publisher.trustedPublisher
        ? `Published through npm trusted publishing (${f.publisher.name}), not a stored token.`
        : `Published by npm user "${f.publisher.name}".`
    );
  }
  return {
    id: 'provenance',
    title: 'Provenance',
    level: branch ? 'note' : 'ok',
    headline: `Built on GitHub Actions from ${p.repo} @ ${short(p.commit)}`,
    certifies,
    doesNot,
    items,
    links: [
      p.commit && p.repo ? { label: 'Attested commit', href: `https://github.com/${p.repo}/commit/${p.commit}` } : null,
      p.runUrl ? { label: 'Build run', href: p.runUrl } : null
    ].filter(Boolean),
    evidence: evidenceList(branch ? ['prov_commit', 'prov_branch'] : ['prov_commit'])
  };
}

function workflowCard(f) {
  const w = f.workflow;
  if (!f.provenance) return null;
  if (!w || !w.fetched) {
    return {
      id: 'workflow',
      title: 'Workflow inputs',
      level: 'note',
      headline: 'Could not read the build workflow at the attested commit',
      certifies: [],
      doesNot: ['Which actions the build used.'],
      items: w?.error ? [w.error] : [],
      evidence: evidenceList(['prov_mutable_ladder'])
    };
  }
  const c = w.counts;
  const mutable = w.refs.filter((r) => r.kind !== 'local' && !r.pinned);
  const label = { github: 'GitHub-owned', 'same-owner': 'same owner', 'third-party': 'third party', docker: 'container' };
  const items = mutable.map((r) => `${r.uses} (${label[r.kind] || r.kind}, line ${r.line})`);
  items.push(
    w.lockfile
      ? 'actions.lock is present at this commit: the action SHAs the workflow resolves were recorded.'
      : 'No .github/workflows/actions.lock at this commit.'
  );
  let level = 'ok';
  if (c.mutableThirdParty > 0) level = 'warn';
  else if (c.mutable > 0) level = 'note';
  return {
    id: 'workflow',
    title: 'Workflow inputs',
    level,
    headline: c.mutable
      ? `${c.mutable} of ${c.total} action references in ${w.path} are mutable${c.mutableThirdParty ? `, ${c.mutableThirdParty} from a third party` : ''}`
      : `All ${c.total} action references in ${w.path} are pinned to commit SHAs`,
    certifies: ['Which workflow file ran, at the attested commit.'],
    doesNot: [
      'Which code a tag such as @v4 pointed to on the day of the build: the tag can move later, and the attestation does not record it.',
      'Actions called from inside composite actions or reusable workflows (not followed here).'
    ],
    items,
    evidence: evidenceList(['prov_mutable_ladder', 'prov_alias', 'prov_drift', 'lock_repos', 'lock_releases'])
  };
}

function sigstoreCard(f) {
  const p = f.provenance;
  if (!p) return null;
  const cert = p.cert;
  const tlog = p.tlog;
  const certifies = [];
  if (cert) certifies.push(`The signer held the identity ${cert.san || '(no SAN found)'} from ${cert.notBefore.slice(11, 16)} to ${cert.notAfter.slice(11, 16)} UTC on ${day(cert.notBefore)}.`);
  if (tlog) certifies.push(`A public append-only log (Rekor, entry ${tlog.logIndex}) recorded the signature at ${tlog.integratedTime}.`);
  return {
    id: 'sigstore',
    title: 'Sigstore signature',
    level: 'ok',
    headline: cert ? `Signed with a ${cert.minutes}-minute certificate, logged in Rekor` : 'Signed through Sigstore, logged in Rekor',
    certifies,
    doesNot: [
      'The log keeps a digest of the signed statement, not the source code or the tarball.',
      'Who wrote or reviewed the code: the identity is a workflow, not a person.'
    ],
    items: [
      `This identity names a public repository (${p.repo}), so the source behind the signature can be inspected. Across Rekor that is the exception, not the rule.`
    ],
    links: tlog ? [{ label: 'Rekor entry', href: `https://search.sigstore.dev/?logIndex=${tlog.logIndex}` }] : [],
    evidence: evidenceList(['sig_cert10', 'sig_public', 'sig_opaque', 'sig_digest'])
  };
}

function distTagCard(f, staleDays) {
  const dt = f.distTags;
  const rows = dt.tags.map((t) => ({ ...t, cls: classifyTag(t, staleDays) }));
  const staleChannels = rows.filter((t) => t.cls === 'stale' && PRE_TAGS.test(t.tag));
  const staleOther = rows.filter((t) => t.cls === 'stale' && !PRE_TAGS.test(t.tag));
  const items = rows.map((t) => {
    const when = t.publishedAt ? `, published ${day(t.publishedAt)}` : '';
    const rel = {
      ahead: 'ahead of latest',
      'newer-build': 'a newer build than latest despite a lower version',
      'recent-older': `older than latest by ${t.daysBeforeLatest} days`,
      stale: t.daysBeforeLatest !== null ? `older than latest by ${t.daysBeforeLatest} days` : 'older than latest'
    }[t.cls];
    return `@${t.tag} -> ${t.version} (${rel}${when})`;
  });
  if (!f.isLatest) items.unshift(`You are looking at ${f.version}; latest is ${f.latest}.`);
  if (f.requestedTag) items.unshift(`@${f.requestedTag} resolves to ${f.version} today.`);
  let headline;
  let level = 'ok';
  if (staleChannels.length) {
    const t = staleChannels[0];
    level = 'warn';
    headline = `npm install ${f.name}@${t.tag} installs ${t.version}, older than latest ${dt.latest}${t.daysBeforeLatest !== null ? ` by ${t.daysBeforeLatest} days` : ''}`;
  } else if (staleOther.length) {
    level = 'note';
    headline = `${staleOther.length} tag${staleOther.length > 1 ? 's point' : ' points'} at an older release line`;
  } else if (rows.length) {
    headline = 'No pre-release tag points behind latest';
  } else {
    headline = 'Only the latest tag is published';
  }
  return {
    id: 'disttags',
    title: 'Dist-tags',
    level,
    headline,
    certifies: [`latest (${dt.latest}) is moved by npm publish itself.`],
    doesNot: [
      'That any other tag is current: maintainers move next, beta and the rest by hand.',
      'npm prints no warning when the tag you install is older than latest.'
    ],
    items,
    rows,
    evidence: evidenceList(['tag_latest', 'tag_divergent', 'tag_stale', 'tag_secondline'])
  };
}

function scriptsCard(f) {
  const s = f.scripts;
  if (!s.any) {
    return {
      id: 'scripts',
      title: 'Install scripts',
      level: 'ok',
      headline: 'Installing runs no script from this package',
      certifies: [],
      doesNot: [`Its ${f.dependencies} direct dependencies may run their own.`],
      items: [],
      evidence: []
    };
  }
  return {
    id: 'scripts',
    title: 'Install scripts',
    level: 'warn',
    headline: `npm install runs code from this package: ${Object.keys(s.hooks).join(', ')}`,
    certifies: [],
    doesNot: ['Provenance and signatures say where this script came from, not what it does when it runs with your permissions.'],
    items: Object.entries(s.hooks).map(([k, v]) => `${k}: ${v}`),
    evidence: [],
    action: 'deep'
  };
}

function deprecatedCard(f) {
  if (!f.deprecated) return null;
  return {
    id: 'deprecated',
    title: 'Deprecated',
    level: 'warn',
    headline: 'The maintainer marked this version deprecated',
    certifies: [],
    doesNot: [],
    items: [String(f.deprecated).slice(0, 300)],
    evidence: []
  };
}

export function buildFindings(facts, cfg = {}) {
  const staleDays = cfg.staleTagDays ?? 180;
  const cards = [
    deprecatedCard(facts),
    provenanceCard(facts),
    workflowCard(facts),
    sigstoreCard(facts),
    distTagCard(facts, staleDays),
    scriptsCard(facts)
  ].filter(Boolean);
  const counts = { warn: 0, note: 0, ok: 0 };
  for (const c of cards) counts[c.level]++;
  return { cards, counts };
}
