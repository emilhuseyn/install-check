import { collectFacts } from './facts/index.js';
import { buildDeepInput } from './facts/tarball.js';
import { fetchManifest } from './facts/registry.js';
import { buildFindings } from './findings.js';
import { SOURCES } from './evidence.js';
import { parsePackageUrl, parseSpec } from './url.js';
import { route, factsForModel, compactFacts, runSummary, runQuestion, runDeep } from './ai.js';
import {
  InferenceMode, warmDevice, loadConfig, defaultConfig, appCheckStatus, deviceAvailability, deviceParams, downloadDeviceModel, readVerdict, writeVerdict
} from './firebase.js';

const $ = (id) => document.getElementById(id);
const chromeApi = globalThis.chrome?.tabs ? globalThis.chrome : null;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const state = {
  cfg: null,
  device: 'checking',
  prefs: { localOnly: false },
  current: null,
  run: 0
};

// ---------- preferences ----------

async function loadPrefs() {
  try {
    const got = await chromeApi?.storage?.local.get('prefs');
    if (got?.prefs) Object.assign(state.prefs, got.prefs);
  } catch {
    /* outside the extension */
  }
  $('local-only').checked = state.prefs.localOnly;
}

$('local-only').addEventListener('change', async (e) => {
  state.prefs.localOnly = e.target.checked;
  try {
    await chromeApi?.storage?.local.set({ prefs: state.prefs });
  } catch {
    /* ignore */
  }
  if (state.current) render(state.current.facts, state.current.findings);
});

// ---------- status ----------

function engineDot(id, cls, title) {
  const el = $(id);
  el.classList.remove('on', 'off', 'wait');
  el.classList.add(cls);
  if (title) el.title = title;
}

async function refreshStatus() {
  const [ac, dp] = await Promise.all([appCheckStatus(), deviceParams()]);
  state.device = await deviceAvailability();
  engineDot('eng-device', state.device === 'available' ? 'on' : state.device === 'unavailable' ? 'off' : 'wait', `Gemini Nano: ${state.device}`);
  engineDot('eng-cloud', state.prefs.localOnly ? 'off' : ac.ok ? 'on' : 'off', ac.ok ? 'Cloud Gemini via Firebase AI Logic (App Check ok)' : `App Check: ${ac.error || 'no token'}`);
  const dl = $('status');
  dl.replaceChildren(
    h('dt', {}, 'Gemini Nano'), h('dd', {}, state.device + (dp?.defaultTopK ? ` (topK ${dp.defaultTopK})` : '')),
    h('dt', {}, 'App Check'), h('dd', {}, ac.ok ? `ok, ${ac.mode}` : `${ac.mode}: ${ac.error || 'no token'}`),
    h('dt', {}, 'Config'), h('dd', {}, state.cfg?.source || 'loading'),
    h('dt', {}, 'Cloud models'), h('dd', {}, state.cfg ? `${state.cfg.cloudModelLight} (light), ${state.cfg.cloudModelDeep} (deep)` : ''),
    h('dt', {}, 'Nano input limit'), h('dd', {}, state.cfg ? `${state.cfg.onDeviceMaxChars} characters` : '')
  );
  const box = $('device-download');
  box.replaceChildren();
  if (state.device === 'downloadable' || state.device === 'downloading') {
    const btn = h('button', { type: 'button' }, 'Download Gemini Nano to this device');
    const prog = h('span', { class: 'muted' }, '');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await downloadDeviceModel((p) => (prog.textContent = ` ${Math.round(p * 100)}%`));
        await refreshStatus();
      } catch (e) {
        prog.textContent = ` ${e.message || e}`;
        btn.disabled = false;
      }
    });
    box.append(btn, prog);
  }
}

function renderSources() {
  $('sources').replaceChildren(...Object.values(SOURCES).map((s) => h('li', {}, s.long)));
}

// ---------- rendering ----------

function viaLine(source, model, ms, reason, extra) {
  const label = source === 'on_device' ? 'on device' : 'cloud';
  return h('div', { class: 'via' },
    h('span', { class: `src ${source}` }, `${source === 'on_device' ? 'Gemini Nano' : model} · ${label}`),
    ms !== undefined && ms !== null ? h('span', {}, `${(ms / 1000).toFixed(1)} s`) : null,
    reason ? h('span', { class: 'why' }, reason) : null,
    extra ? h('span', { class: 'why' }, extra) : null
  );
}

function signalCard(card) {
  const body = h('div', { class: 'body' });
  if (card.certifies.length) body.append(h('div', {}, h('h3', {}, 'Certifies'), h('ul', { class: 'yes' }, card.certifies.map((x) => h('li', {}, x)))));
  if (card.doesNot.length) body.append(h('div', {}, h('h3', {}, 'Does not certify'), h('ul', { class: 'no' }, card.doesNot.map((x) => h('li', {}, x)))));
  if (card.items?.length) body.append(h('div', {}, h('h3', {}, 'On this version'), h('ul', { class: 'items' }, card.items.map((x) => h('li', {}, x)))));
  if (card.evidence?.length) {
    body.append(h('div', { class: 'evidence' },
      h('h3', {}, 'Measured across the registry'),
      h('ul', {}, card.evidence.map((e) => h('li', {}, e.text, ' ', h('span', { class: 'from' }, `(${e.sourceShort})`))))
    ));
  }
  if (card.links?.length) body.append(h('div', { class: 'links' }, card.links.map((l) => h('a', { href: l.href, target: '_blank', rel: 'noopener' }, l.label))));
  return h('details', { class: `card signal ${card.level}`, open: card.level === 'warn' ? true : null, 'data-id': card.id },
    h('summary', {},
      h('span', { class: 'dot' }),
      h('span', {}, h('div', { class: 't' }, card.title), h('div', { class: 'h' }, card.headline)),
      h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')
    ),
    body
  );
}

function render(facts, findings) {
  const main = $('main');
  const { counts } = findings;
  const header = h('div', { class: 'pkg' },
    h('h1', {}, facts.name, ' ', h('small', {}, facts.version)),
    h('div', { class: 'tally' },
      counts.warn ? h('span', { class: 'pill warn' }, `${counts.warn} to check`) : null,
      counts.note ? h('span', { class: 'pill note' }, `${counts.note} to know`) : null,
      h('span', { class: 'pill ok' }, `${counts.ok} fine`)
    )
  );
  const summary = h('section', { class: 'card summary', id: 'summary' }, h('h2', {}, 'In plain words'),
    h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'width:85%' }), h('div', { class: 'skeleton', style: 'width:70%' }));
  const signals = findings.cards.map(signalCard);
  main.replaceChildren(header, summary, ...signals, deepSection(facts), askSection());
}

// ---------- summary (hybrid) ----------

function log(...args) {
  console.info('[Install Check]', ...args);
}

function withTimeout(p, ms, message) {
  return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

// A visible "writing" label with a running clock, so the engine is observable before the answer arrives.
function pendingLine(source, model, reason) {
  const t0 = performance.now();
  const clock = h('span', {}, '0.0 s');
  const el = h('div', { class: 'via' },
    h('span', { class: `src ${source}` }, source === 'on_device' ? 'Gemini Nano · on device · writing' : `${model} · cloud · writing`),
    clock,
    reason ? h('span', { class: 'why' }, reason) : null
  );
  const iv = setInterval(() => {
    if (!el.isConnected) return clearInterval(iv);
    clock.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`;
  }, 200);
  return el;
}

async function summarizeOnDevice(texts, run) {
  const box = $('summary');
  const routing = { mode: InferenceMode.ONLY_ON_DEVICE, model: state.cfg.cloudModelLight, reason: 'On-device only, on request.' };
  box.replaceChildren(h('h2', {}, 'In plain words'), h('div', { class: 'skeleton' }), pendingLine('on_device', null, routing.reason));
  log('summary: on-device only, on request');
  try {
    const out = await runSummary(texts, routing, true);
    log('summary: done', { source: out.source, ms: out.ms });
    if (run !== state.run) return;
    box.replaceChildren(h('h2', {}, 'In plain words'), h('ol', {}, out.lines.map((l) => h('li', {}, l))), viaLine(out.source, out.model, out.ms, routing.reason));
    engineDot('eng-device', 'on');
  } catch (e) {
    log('summary: on-device only failed', String(e.message || e));
    box.replaceChildren(h('h2', {}, 'In plain words'), h('div', { class: 'error' }, `Gemini Nano could not write the summary: ${e.message || e}`));
  }
}

async function summarize(facts, findings, run) {
  const box = $('summary');
  const texts = { full: factsForModel(facts, findings), compact: compactFacts(facts, findings) };
  const text = texts.compact;
  if (state.device === 'checking') state.device = await deviceAvailability();
  const routing = route('summary', text.length, state.cfg, state.prefs, state.device);
  if (routing.blocked) {
    box.replaceChildren(h('h2', {}, 'In plain words'), h('p', { class: 'muted' }, routing.reason));
    return;
  }
  const expectDevice = routing.mode !== InferenceMode.ONLY_IN_CLOUD && state.device === 'available';
  const skeleton = () => [h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'width:85%' })];
  box.replaceChildren(h('h2', {}, 'In plain words'), ...skeleton(), pendingLine(expectDevice ? 'on_device' : 'in_cloud', routing.model, routing.reason));
  log('summary: start', { route: routing.mode, expected: expectDevice ? 'on_device' : 'in_cloud', chars: text.length, nano: state.device });
  try {
    let out;
    let reason = routing.reason;
    if (expectDevice && routing.mode !== InferenceMode.ONLY_ON_DEVICE) {
      const limit = state.cfg.onDeviceTimeoutS;
      try {
        out = await withTimeout(runSummary(texts, routing, true), limit * 1000, `Gemini Nano did not answer within ${limit} s`);
      } catch (e) {
        log('summary: on-device attempt failed, using the cloud', String(e.message || e));
        if (run !== state.run) return;
        reason = `${e.message || e}, so the cloud answered.`;
        box.replaceChildren(h('h2', {}, 'In plain words'), ...skeleton(), pendingLine('in_cloud', routing.model, reason));
        out = await runSummary(texts, { ...routing, mode: InferenceMode.ONLY_IN_CLOUD }, false);
      }
    } else {
      out = await runSummary(texts, routing, expectDevice);
    }
    log('summary: done', { source: out.source, model: out.model, ms: out.ms });
    if (run !== state.run) return;
    const retry = out.source !== 'on_device' && state.device === 'available'
      ? h('button', { type: 'button', class: 'link', onclick: () => summarizeOnDevice(texts, run) }, 'Run on Gemini Nano only')
      : null;
    box.replaceChildren(h('h2', {}, 'In plain words'), h('ol', {}, out.lines.map((l) => h('li', {}, l))), viaLine(out.source, out.model, out.ms, reason), ...(retry ? [retry] : []));
    engineDot(out.source === 'on_device' ? 'eng-device' : 'eng-cloud', 'on');
  } catch (e) {
    log('summary: failed', String(e.message || e));
    if (run !== state.run) return;
    box.replaceChildren(h('h2', {}, 'In plain words'), h('div', { class: 'error' }, `Could not write the summary: ${e.message || e}`), h('p', { class: 'muted' }, 'The signal cards below do not depend on a model.'));
  }
}

// ---------- deep check (cloud, on request, shared through Firestore) ----------

function renderDeep(target, d, meta) {
  const r = d;
  const flags = [
    ['network', r.network], ['spawns processes', r.spawnsProcesses], ['reads environment', r.readsEnvironment], ['writes outside package', r.writesOutsidePackage]
  ];
  target.replaceChildren(...[
    h('div', { class: 'row' }, h('span', { class: `risk ${r.risk}` }, r.risk === 'none' ? 'nothing runs' : r.risk), h('strong', {}, 'Install-time review')),
    h('p', {}, r.summary || ''),
    h('div', { class: 'flags' }, flags.map(([k, v]) => h('span', { class: `flag ${v ? 'yes' : ''}` }, `${v ? '●' : '○'} ${k}`))),
    r.behaviors?.length ? h('ul', { class: 'behaviors' }, r.behaviors.map((b) => h('li', {}, h('span', { class: `c-${b.concern}` }, b.concern), ' ', b.behavior, ' ', h('span', { class: 'file' }, b.file)))) : null,
    r.changesSincePrevious ? h('p', {}, h('strong', {}, 'Since the previous version: '), r.changesSincePrevious) : null,
    viaLine(meta.source, meta.model, meta.ms, meta.reason, meta.extra)
  ].filter(Boolean));
}

function deepSection(facts) {
  const out = h('div', {});
  const btn = h('button', { class: 'primary', type: 'button' }, facts.scripts.any ? 'Review install code in the cloud' : 'Review this release in the cloud');
  const note = h('p', {},
    facts.scripts.any
      ? 'Sends the install script files and a file diff against '
      : 'Sends a file diff against ',
    facts.previous ? h('code', {}, facts.previous) : 'nothing (no earlier version)',
    ' to Gemini through Firebase AI Logic. The result is cached in Firestore for every user of this version.'
  );
  const sec = h('section', { class: 'card deep', id: 'deep' }, h('h2', {}, 'Deep check'), note, h('div', { class: 'row' }, btn), out);

  readVerdict(facts.name, facts.version).then((v) => {
    if (!v?.deep || state.current?.facts !== facts) return;
    const when = v.createdAt?.toDate ? v.createdAt.toDate() : null;
    const age = when ? (Date.now() - when.getTime()) / 86400000 : 0;
    if (age > state.cfg.cacheTtlDays) return;
    btn.textContent = 'Run again';
    renderDeep(out, v.deep, { source: v.inferenceSource, model: v.model, reason: 'Shared cache in Firestore: no new cloud call.', extra: when ? `reviewed ${when.toISOString().slice(0, 10)}` : null });
  }).catch(() => {});

  btn.addEventListener('click', async () => {
    const routing = route('deep', 0, state.cfg, state.prefs, state.device);
    if (routing.blocked) {
      out.replaceChildren(h('p', { class: 'muted' }, routing.reason));
      return;
    }
    btn.disabled = true;
    out.replaceChildren(h('p', { class: 'muted' }, 'Downloading and unpacking the tarballs in this browser...'));
    try {
      const prevManifest = facts.previous ? await fetchManifest(facts.name, facts.previous).catch(() => null) : null;
      const prevFacts = prevManifest?.dist?.tarball ? { version: facts.previous, tarball: prevManifest.dist.tarball } : null;
      const input = await buildDeepInput(facts, prevFacts, state.cfg);
      out.replaceChildren(h('p', { class: 'muted' }, `Sending ${input.files.length} files and the diff (${JSON.stringify(input).length} characters) to ${routing.model}...`));
      const res = await runDeep(input, routing, state.cfg.cloudModelLight, state.cfg.deepTimeoutS * 1000);
      renderDeep(out, res.result, { source: res.source, model: res.model, ms: res.ms, reason: routing.reason, extra: res.note });
      writeVerdict(facts.name, facts.version, res.result, {
        model: res.model, inferenceSource: res.source, provenanceCommit: facts.provenance?.commit, previous: facts.previous
      }).catch((e) => out.append(h('p', { class: 'muted' }, `Not cached: ${e.message || e}`)));
    } catch (e) {
      out.replaceChildren(h('div', { class: 'error' }, `Deep check failed: ${e.message || e}`));
    } finally {
      btn.disabled = false;
    }
  });
  return sec;
}

// ---------- questions (hybrid, streaming) ----------

function askSection() {
  const input = h('input', { type: 'text', placeholder: 'Ask about this package', 'aria-label': 'Question' });
  const answer = h('div', { class: 'answer' });
  const ask = async (q) => {
    if (!q.trim() || !state.current) return;
    input.value = q;
    const { facts, findings } = state.current;
    const onDevice = state.device === 'available' && !state.prefs.noDevice;
    const text = onDevice ? compactFacts(facts, findings) : factsForModel(facts, findings);
    const routing = route('question', text.length + q.length, state.cfg, state.prefs, state.device);
    log('question: start', { expected: onDevice ? 'on_device' : 'in_cloud', chars: text.length });
    if (routing.blocked) {
      answer.replaceChildren(h('p', { class: 'muted' }, routing.reason));
      return;
    }
    const out = h('div', {});
    answer.replaceChildren(out);
    const t0 = performance.now();
    try {
      let source = null;
      for await (const part of runQuestion(text, q, routing)) {
        if (part.done) source = part.source;
        else {
          out.append(part.text);
          source = part.source;
        }
      }
      answer.append(viaLine(source, routing.model, performance.now() - t0, routing.reason));
    } catch (e) {
      answer.replaceChildren(h('div', { class: 'error' }, e.message || String(e)));
    }
  };
  const chips = ['Is @next newer than latest here?', 'What did the build pull in that provenance does not show?', 'What should I pin before installing?'];
  const form = h('form', {}, input, h('button', { type: 'submit' }, 'Ask'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    ask(input.value);
  });
  return h('section', { class: 'card ask' }, h('h2', {}, 'Ask'),
    h('div', { class: 'chips' }, chips.map((c) => h('button', { type: 'button', onclick: () => ask(c) }, c))),
    form, answer);
}

// ---------- flow ----------

async function check(name, version) {
  const run = ++state.run;
  $('lookup-input').value = version ? `${name}@${version}` : name;
  $('main').replaceChildren(h('section', { class: 'card' }, h('h2', {}, 'Reading the registry'), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'width:60%' })));
  try {
    if (!state.cfg) state.cfg = await Promise.race([state.cfgPromise, new Promise((r) => setTimeout(() => r(defaultConfig()), 1500))]);
    const facts = await collectFacts(name, version, { maxPackumentBytes: state.cfg.maxPackumentMb * 1048576 });
    if (run !== state.run) return;
    if (facts.notFound) {
      $('main').replaceChildren(h('div', { class: 'error' }, `${name} is not on the npm registry.`));
      return;
    }
    const findings = buildFindings(facts, { staleTagDays: state.cfg.staleTagDays });
    state.current = { facts, findings };
    render(facts, findings);
    summarize(facts, findings, run);
  } catch (e) {
    if (run !== state.run) return;
    $('main').replaceChildren(h('div', { class: 'error' }, `Could not read ${name}: ${e.message || e}`));
  }
}

$('lookup').addEventListener('submit', (e) => {
  e.preventDefault();
  const spec = parseSpec($('lookup-input').value);
  if (spec) check(spec.name, spec.version);
});

async function fromActiveTab() {
  if (!chromeApi) return false;
  const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
  const spec = parsePackageUrl(tab?.url);
  if (!spec) return false;
  const key = `${spec.name}@${spec.version || ''}`;
  if (state.lastKey === key) return true;
  state.lastKey = key;
  check(spec.name, spec.version);
  return true;
}

async function init() {
  renderSources();
  await loadPrefs();
  deviceAvailability().then((a) => {
    if (state.device === 'checking') state.device = a;
    log('Gemini Nano availability:', a);
    if (a === 'available' && !state.prefs.noWarm) warmDevice();
  });
  state.cfgPromise = loadConfig().then((c) => {
    state.cfg = c;
    refreshStatus();
    return c;
  });
  const qs = new URLSearchParams(location.search);
  const spec = qs.get('pkg') ? parseSpec(qs.get('pkg')) : null;
  if (spec) check(spec.name, qs.get('v') || spec.version);
  else await fromActiveTab();
  if (chromeApi) {
    chromeApi.tabs.onActivated.addListener(() => fromActiveTab());
    chromeApi.tabs.onUpdated.addListener((_id, info, tab) => {
      if (tab.active && info.url) fromActiveTab();
    });
    chromeApi.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'show' && msg.name) {
        state.lastKey = `${msg.name}@${msg.version || ''}`;
        check(msg.name, msg.version);
      }
    });
  }
}

init();
