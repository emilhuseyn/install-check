import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, previousVersion } from '../src/facts/semver.js';
import { parseUses, summarizeRefs } from '../src/facts/workflow.js';
import { analyzeTags, installScripts } from '../src/facts/index.js';
import { scriptTargets, untar } from '../src/facts/tarball.js';
import { parsePackageUrl, parseSpec } from '../src/url.js';
import { buildFindings, classifyTag } from '../src/findings.js';
import { EVIDENCE, SOURCES } from '../src/evidence.js';

test('semver ordering, prereleases and previous version', () => {
  assert.equal(compare('1.2.3', '1.2.10'), -1);
  assert.equal(compare('2.0.0-beta.2', '2.0.0'), -1);
  assert.equal(compare('2.0.0-beta.10', '2.0.0-beta.2'), 1);
  assert.equal(previousVersion(['1.0.0', '1.1.0', '1.2.0-rc.1', '1.2.0'], '1.2.0'), '1.1.0');
  assert.equal(previousVersion(['1.0.0'], '1.0.0'), null);
});

test('uses: references are classified like the measurement', () => {
  const yaml = [
    'steps:',
    '  - uses: actions/checkout@v4',
    '  - uses: actions/setup-node@1d0ff469b7ec7b3cb9d8673fde0c81c44821de2a # v4',
    '  - uses: acme/release-tool@main',
    "  - uses: 'octo/thing/sub@v1'",
    '  - uses: ./.github/actions/local',
    'jobs:',
    '  call:',
    '    uses: octo/.github/.github/workflows/release.yml@v2'
  ].join('\n');
  const refs = parseUses(yaml, 'octo');
  const kinds = refs.map((r) => `${r.kind}:${r.pinned}`);
  assert.deepEqual(kinds, ['github:false', 'github:true', 'third-party:false', 'same-owner:false', 'local:true', 'same-owner:false']);
  assert.equal(refs[5].reusableWorkflow, true);
  assert.deepEqual(summarizeRefs(refs), { total: 5, pinned: 1, mutable: 4, mutableGithub: 1, mutableSameOwner: 2, mutableThirdParty: 1 });
});

test('dist-tags: older than latest, and newer builds with a lower version', () => {
  const times = { '5.0.0': '2026-01-01T00:00:00Z', '4.0.0-beta.1': '2023-07-01T00:00:00Z', '5.0.0-canary.3': '2026-02-01T00:00:00Z', '6.0.0-next.1': '2026-03-01T00:00:00Z' };
  const out = analyzeTags({ latest: '5.0.0', beta: '4.0.0-beta.1', canary: '5.0.0-canary.3', next: '6.0.0-next.1' }, times);
  const by = Object.fromEntries(out.tags.map((t) => [t.tag, t]));
  assert.equal(by.beta.olderThanLatest, true);
  assert.equal(by.beta.differentMajor, true);
  assert.equal(by.beta.daysBeforeLatest, 915);
  assert.equal(classifyTag(by.beta, 180), 'stale');
  assert.equal(classifyTag(by.canary, 180), 'newer-build');
  assert.equal(classifyTag(by.next, 180), 'ahead');
});

test('install scripts, including implicit node-gyp', () => {
  assert.deepEqual(installScripts({ scripts: { postinstall: 'node install.js', test: 'x' } }).hooks, { postinstall: 'node install.js' });
  assert.equal(installScripts({ gypfile: true }).hooks.install.startsWith('node-gyp rebuild'), true);
  assert.equal(installScripts({ scripts: { build: 'tsc' } }).any, false);
  const files = new Map([['install.js', 1], ['scripts/post.cjs', 1], ['binding.gyp', 1]]);
  assert.deepEqual(scriptTargets({ postinstall: 'node install.js && node ./scripts/post.cjs' }, files).sort(), ['binding.gyp', 'install.js', 'scripts/post.cjs']);
  const coreJs = new Map([['postinstall.js', 1]]);
  assert.deepEqual(scriptTargets({ postinstall: "node -e \"try{require('./postinstall')}catch(e){}\"" }, coreJs), ['postinstall.js']);
});

test('untar reads ustar entries and strips the package/ prefix', () => {
  const enc = new TextEncoder();
  const header = (name, size) => {
    const h = new Uint8Array(512);
    h.set(enc.encode(name), 0);
    h.set(enc.encode(size.toString(8).padStart(11, '0')), 124);
    h[156] = 48;
    return h;
  };
  const body = enc.encode('hello');
  const block = new Uint8Array(512);
  block.set(body);
  const tar = new Uint8Array(512 * 4);
  tar.set(header('package/a.txt', body.length), 0);
  tar.set(block, 512);
  const files = untar(tar);
  assert.equal(new TextDecoder().decode(files.get('a.txt')), 'hello');
});

test('npmjs.com URLs and install specs', () => {
  assert.deepEqual(parsePackageUrl('https://www.npmjs.com/package/@scope/pkg/v/1.2.3?activeTab=code'), { name: '@scope/pkg', version: '1.2.3' });
  assert.deepEqual(parsePackageUrl('https://www.npmjs.com/package/react'), { name: 'react', version: undefined });
  assert.equal(parsePackageUrl('https://github.com/x/y'), null);
  assert.deepEqual(parseSpec('npm i react@beta'), { name: 'react', version: 'beta' });
  assert.deepEqual(parseSpec('@scope/pkg'), { name: '@scope/pkg', version: undefined });
});

test('findings cite only registered evidence and flag a stale @next', () => {
  const facts = {
    name: 'demo', version: '2.0.0', latest: '2.0.0', isLatest: true, requestedTag: null, dependencies: 3,
    deprecated: null, publisher: null, publishAttestation: true,
    scripts: { hooks: { postinstall: 'node x.js' }, any: true },
    distTags: { latest: '2.0.0', tags: [{ tag: 'next', version: '1.0.0-rc.1', olderThanLatest: true, daysBeforeLatest: 400, publishedAt: null }] },
    provenance: {
      repo: 'o/demo', commit: 'a'.repeat(40), ref: 'refs/heads/main', refKind: 'branch', workflowPath: '.github/workflows/r.yml',
      githubHosted: true, cert: { notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2026-01-01T00:10:00.000Z', minutes: 10, san: 'x' },
      tlog: { logIndex: 1, integratedTime: '2026-01-01T00:00:00.000Z' }
    },
    workflow: { fetched: true, path: '.github/workflows/r.yml', lockfile: false, refs: [{ uses: 'evil/act@v1', kind: 'third-party', pinned: false, line: 3 }], counts: { total: 1, pinned: 0, mutable: 1, mutableGithub: 0, mutableSameOwner: 0, mutableThirdParty: 1 } }
  };
  const { cards, counts } = buildFindings(facts, { staleTagDays: 180 });
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(by.disttags.level, 'warn');
  assert.match(by.disttags.headline, /demo@next installs 1\.0\.0-rc\.1, older than latest 2\.0\.0 by 400 days/);
  assert.equal(by.workflow.level, 'warn');
  assert.equal(by.provenance.level, 'note');
  assert.equal(counts.warn, 3);
  for (const c of cards) for (const e of c.evidence) assert.ok(EVIDENCE[e.key] && SOURCES[e.source]);
});
