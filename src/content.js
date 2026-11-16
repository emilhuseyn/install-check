// npmjs.com package pages: a compact Install Check strip under the package title, and a note under
// npm's own Provenance box. Facts come from the background worker; nothing here calls a model.

import { parsePackageUrl } from './url.js';

const HOST_ID = 'install-check-host';
const NOTE_ID = 'install-check-prov-note';
let lastKey = null;

const CSS = `
:host { all: initial; }
.strip { font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1d1d1b; background: #fbfaf8;
  border: 1px solid #e7e4dd; border-radius: 10px; padding: 10px 12px; margin: 10px 0 4px; display: grid; gap: 6px; max-width: 760px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.brand { font-weight: 650; }
.pill { border-radius: 999px; padding: 1px 8px; font-weight: 600; font-size: 12px; }
.warn { color: #b3261e; background: #fbe9e7; } .note { color: #8a5a00; background: #fbf1dc; } .ok { color: #1f7a4d; background: #e8f4ec; }
ul { margin: 0; padding-left: 18px; display: grid; gap: 2px; }
li.l-warn::marker { color: #b3261e; } li.l-note::marker { color: #8a5a00; }
button { font: inherit; font-weight: 600; border: 1px solid #1d1d1b; background: #1d1d1b; color: #fbfaf8; border-radius: 8px; padding: 4px 10px; cursor: pointer; margin-left: auto; }
.muted { color: #8a887f; }
`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function mountPoint() {
  const h1 = document.querySelector('#top h1');
  if (h1?.parentElement) return { parent: h1.parentElement.parentElement, after: h1.parentElement };
  const aside = document.querySelector('main aside');
  if (aside) return { parent: aside, before: aside.firstChild };
  return null;
}

function openPanel(spec) {
  chrome.runtime.sendMessage({ type: 'open', name: spec.name, version: spec.version });
}

function renderStrip(spec, data) {
  document.getElementById(HOST_ID)?.remove();
  const mp = mountPoint();
  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const box = el('div', 'strip');
  const row = el('div', 'row');
  row.append(el('span', 'brand', 'Install Check'));
  if (data.error) {
    row.append(el('span', 'muted', `could not read the registry (${data.error})`));
  } else {
    if (data.counts.warn) row.append(el('span', 'pill warn', `${data.counts.warn} to check`));
    if (data.counts.note) row.append(el('span', 'pill note', `${data.counts.note} to know`));
    row.append(el('span', 'pill ok', `${data.counts.ok} fine`));
  }
  const btn = el('button', '', 'What do these signals prove?');
  btn.addEventListener('click', () => openPanel(spec));
  row.append(btn);
  box.append(row);
  if (data.top?.length) {
    const ul = el('ul');
    for (const t of data.top) ul.append(el('li', `l-${t.level}`, `${t.title}: ${t.headline}`));
    box.append(ul);
  }
  root.append(style, box);
  if (mp?.after) mp.after.after(host);
  else if (mp?.before) mp.parent.insertBefore(host, mp.before);
  else {
    Object.assign(host.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483646, maxWidth: '420px' });
    document.body.append(host);
  }

  document.getElementById(NOTE_ID)?.remove();
  const provHeader = document.getElementById('provenance-details-header');
  if (provHeader && data.provenanceNote) {
    const note = document.createElement('div');
    note.id = NOTE_ID;
    const nr = note.attachShadow({ mode: 'open' });
    const s2 = document.createElement('style');
    s2.textContent = CSS;
    const p = el('div', 'strip');
    const r2 = el('div', 'row');
    r2.append(el('span', '', data.provenanceNote));
    const b2 = el('button', '', 'What it leaves out');
    b2.addEventListener('click', () => openPanel(spec));
    r2.append(b2);
    p.append(r2);
    nr.append(s2, p);
    provHeader.after(note);
  }
}

async function update() {
  const spec = parsePackageUrl(location.href);
  if (!spec) {
    document.getElementById(HOST_ID)?.remove();
    document.getElementById(NOTE_ID)?.remove();
    lastKey = null;
    return;
  }
  const key = `${spec.name}@${spec.version || ''}`;
  if (key === lastKey && document.getElementById(HOST_ID)) return;
  lastKey = key;
  let data;
  try {
    data = await chrome.runtime.sendMessage({ type: 'quick', name: spec.name, version: spec.version });
  } catch (e) {
    data = { error: String(e.message || e) };
  }
  if (lastKey !== key) return;
  renderStrip(spec, data || { error: 'no answer' });
}

update();
setInterval(update, 1000);
