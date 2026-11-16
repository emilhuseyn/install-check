import { fetchAbbreviated, fetchManifest, fetchAttestations, fetchTimes } from './registry.js';
import { parseProvenance } from './provenance.js';
import { inspectWorkflow } from './workflow.js';
import { compare, parse, isPrerelease, previousVersion } from './semver.js';

const DAY = 86400000;
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];

export function analyzeTags(distTags, times) {
  const latest = distTags.latest;
  const lp = parse(latest);
  const out = [];
  for (const [tag, version] of Object.entries(distTags)) {
    if (tag === 'latest') continue;
    const p = parse(version);
    const cmp = compare(version, latest);
    const t = times?.[version] ? Date.parse(times[version]) : null;
    const tl = times?.[latest] ? Date.parse(times[latest]) : null;
    out.push({
      tag,
      version,
      cmpLatest: cmp,
      olderThanLatest: cmp < 0,
      differentMajor: !!(p && lp && p.major !== lp.major),
      prerelease: isPrerelease(version),
      publishedAt: t ? new Date(t).toISOString() : null,
      daysBeforeLatest: t && tl && cmp < 0 ? Math.round((tl - t) / DAY) : null
    });
  }
  out.sort((a, b) => a.tag.localeCompare(b.tag));
  return { latest, latestPublishedAt: times?.[latest] || null, tags: out };
}

export function installScripts(manifest, abbrevVersion) {
  const scripts = manifest?.scripts || {};
  const hooks = {};
  for (const h of INSTALL_HOOKS) if (scripts[h]) hooks[h] = scripts[h];
  const implicitGyp = !Object.keys(hooks).length && (manifest?.gypfile || abbrevVersion?.hasInstallScript);
  if (implicitGyp) hooks.install = 'node-gyp rebuild (implicit: package ships binding.gyp)';
  return { hooks, any: Object.keys(hooks).length > 0 };
}

export async function collectFacts(name, versionHint, opts = {}) {
  const maxPackumentBytes = opts.maxPackumentBytes || 8 * 1048576;
  const abbrev = await fetchAbbreviated(name);
  if (!abbrev) return { name, notFound: true };
  const distTags = abbrev['dist-tags'] || {};
  const versions = Object.keys(abbrev.versions || {});
  const hint = versionHint && distTags[versionHint] ? distTags[versionHint] : versionHint;
  const version = hint && abbrev.versions[hint] ? hint : distTags.latest;
  const av = abbrev.versions[version] || {};

  const [att, manifest, times] = await Promise.all([
    fetchAttestations(name, version).catch(() => null),
    fetchManifest(name, version).catch(() => null),
    fetchTimes(name, maxPackumentBytes).catch(() => null)
  ]);

  const { provenance, publishAttestation } = parseProvenance(att);
  const workflow = provenance ? await inspectWorkflow(provenance) : null;
  const npmUser = manifest?._npmUser || null;

  return {
    schema: 1,
    name,
    version,
    latest: distTags.latest,
    isLatest: version === distTags.latest,
    requestedTag: versionHint && distTags[versionHint] ? versionHint : null,
    previous: previousVersion(versions, version),
    versionCount: versions.length,
    publishedAt: times?.[version] || null,
    deprecated: manifest?.deprecated || av.deprecated || null,
    tarball: av.dist?.tarball || manifest?.dist?.tarball || null,
    unpackedSize: av.dist?.unpackedSize || manifest?.dist?.unpackedSize || null,
    publisher: npmUser ? { name: npmUser.name || null, trustedPublisher: !!npmUser.trustedPublisher } : null,
    distTags: analyzeTags(distTags, times),
    timesAvailable: !!times,
    scripts: installScripts(manifest, av),
    dependencies: Object.keys(manifest?.dependencies || {}).length,
    provenance,
    publishAttestation,
    workflow,
    collectedAt: new Date().toISOString()
  };
}
