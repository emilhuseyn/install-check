import { collectFacts } from './facts/index.js';
import { buildFindings } from './findings.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const cache = new Map();
const TTL = 10 * 60 * 1000;

async function quick(name, version) {
  const key = `${name}@${version || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const facts = await collectFacts(name, version, { maxPackumentBytes: 24 * 1048576 });
  if (facts.notFound) return { error: 'not on the registry' };
  const { cards, counts } = buildFindings(facts);
  const rank = { warn: 0, note: 1, ok: 2 };
  const top = cards
    .filter((c) => c.level !== 'ok')
    .sort((a, b) => rank[a.level] - rank[b.level])
    .slice(0, 3)
    .map((c) => ({ title: c.title, level: c.level, headline: c.headline }));
  const p = facts.provenance;
  const provenanceNote = p
    ? `Install Check: this badge names commit ${p.commit?.slice(0, 7)}${p.refKind === 'branch' ? ` on a branch (${p.ref.replace('refs/heads/', '')})` : ''}. It does not record what the build pulled in.`
    : null;
  const data = { counts, top, provenanceNote, version: facts.version };
  cache.set(key, { at: Date.now(), data });
  return data;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'quick') {
    quick(msg.name, msg.version).then(sendResponse, (e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === 'open' && sender.tab?.id !== undefined) {
    chrome.sidePanel
      .open({ tabId: sender.tab.id })
      .then(() => setTimeout(() => chrome.runtime.sendMessage({ type: 'show', name: msg.name, version: msg.version }).catch(() => {}), 400))
      .catch(() => {});
  }
  return false;
});
