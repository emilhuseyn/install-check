import { initializeApp } from 'firebase/app';
import { initializeAppCheck, CustomProvider, getToken } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore/lite';
import { getRemoteConfig, fetchAndActivate, getValue, isSupported as remoteConfigSupported } from 'firebase/remote-config';
import firebaseConfig from '../firebase-config.json';

/* global __APPCHECK_DEBUG_TOKEN__, __APPCHECK_EXCHANGE_URL__ */
// Development: a debug token registered in the Firebase console, injected at build time from
// appcheck-debug-token.local (never committed). Production: a Chrome extension cannot run
// reCAPTCHA, so App Check uses a CustomProvider backed by a token-minting endpoint (see README).
const DEBUG_TOKEN = __APPCHECK_DEBUG_TOKEN__;
const EXCHANGE_URL = __APPCHECK_EXCHANGE_URL__;
if (DEBUG_TOKEN) self.FIREBASE_APPCHECK_DEBUG_TOKEN = DEBUG_TOKEN;

export const app = initializeApp(firebaseConfig);

export const appCheck = initializeAppCheck(app, {
  provider: new CustomProvider({
    getToken: async () => {
      if (!EXCHANGE_URL) throw new Error('No production App Check provider configured for this build.');
      const res = await fetch(EXCHANGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extensionId: globalThis.chrome?.runtime?.id || null })
      });
      if (!res.ok) throw new Error(`App Check exchange failed: HTTP ${res.status}`);
      const { token, expireTimeMillis } = await res.json();
      return { token, expireTimeMillis };
    }
  }),
  isTokenAutoRefreshEnabled: true
});

export const appCheckMode = DEBUG_TOKEN ? 'debug token' : EXCHANGE_URL ? 'custom provider' : 'not configured';

export async function appCheckStatus() {
  try {
    const t = await getToken(appCheck, false);
    return { ok: !!t.token, mode: appCheckMode };
  } catch (e) {
    return { ok: false, mode: appCheckMode, error: String(e.message || e) };
  }
}

// ---------- Remote Config: thresholds and model names ----------

export const CONFIG_DEFAULTS = {
  cloud_model_light: 'gemini-3.5-flash-lite',
  cloud_model_deep: 'gemini-3.5-flash-lite',
  on_device_max_chars: 9000,
  on_device_timeout_s: 30,
  stale_tag_days: 180,
  max_packument_mb: 24,
  deep_max_tarball_mb: 15,
  deep_max_chars: 60000,
  deep_timeout_s: 60,
  cache_ttl_days: 30
};

function camel(k) {
  return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export function defaultConfig() {
  const cfg = {};
  for (const [k, v] of Object.entries(CONFIG_DEFAULTS)) cfg[camel(k)] = v;
  cfg.source = 'built-in defaults';
  return cfg;
}

export async function loadConfig() {
  const cfg = defaultConfig();
  try {
    if (!(await remoteConfigSupported())) return cfg;
    const rc = getRemoteConfig(app);
    rc.settings.minimumFetchIntervalMillis = 10 * 60 * 1000;
    rc.defaultConfig = CONFIG_DEFAULTS;
    await fetchAndActivate(rc);
    let remote = 0;
    for (const [k, v] of Object.entries(CONFIG_DEFAULTS)) {
      const val = getValue(rc, k);
      if (val.getSource() === 'remote') remote++;
      cfg[camel(k)] = typeof v === 'number' ? val.asNumber() : val.asString();
    }
    cfg.source = remote ? `Remote Config (${remote} of ${Object.keys(CONFIG_DEFAULTS).length} values from the server)` : 'Remote Config defaults';
  } catch (e) {
    cfg.source = `built-in defaults (Remote Config: ${e.message || e})`;
  }
  return cfg;
}

// ---------- Firebase AI Logic: hybrid models ----------

const ai = getAI(app, { backend: new GoogleAIBackend() });
export { InferenceMode };

const TEXT_EN = [{ type: 'text', languages: ['en'] }];

export function hybridModel({ mode, cloudModel, schema, constraint, temperature = 0.2, timeoutMs }) {
  return getGenerativeModel(ai, {
    mode,
    inCloudParams: {
      model: cloudModel,
      generationConfig: schema
        ? { responseMimeType: 'application/json', responseSchema: schema, temperature }
        : { temperature }
    },
    onDeviceParams: {
      createOptions: { expectedInputs: TEXT_EN, expectedOutputs: TEXT_EN },
      promptOptions: constraint ? { responseConstraint: constraint } : {}
    }
  }, timeoutMs ? { timeout: timeoutMs } : undefined);
}

export async function deviceAvailability() {
  if (typeof globalThis.LanguageModel === 'undefined') return 'unavailable';
  try {
    return await within(globalThis.LanguageModel.availability({ expectedInputs: TEXT_EN, expectedOutputs: TEXT_EN }), 8000, 'unavailable');
  } catch {
    return 'unavailable';
  }
}

const within = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

export async function deviceParams() {
  try {
    return (await within(globalThis.LanguageModel?.params?.() ?? null, 2000, null)) || null;
  } catch {
    return null;
  }
}

// Loads Gemini Nano into memory while the registry is being read, so the first summary does not pay for it.
// The session is kept open (and unused) so Chrome does not unload the model between prompts.
let warmSession = null;
export async function warmDevice() {
  if (warmSession || typeof globalThis.LanguageModel === 'undefined') return false;
  const t0 = performance.now();
  try {
    warmSession = await globalThis.LanguageModel.create({ expectedInputs: TEXT_EN, expectedOutputs: TEXT_EN });
    console.info('[Install Check] Gemini Nano loaded in', Math.round(performance.now() - t0), 'ms');
    return true;
  } catch (e) {
    console.info('[Install Check] Gemini Nano warm-up failed:', String(e.message || e));
    return false;
  }
}

export async function downloadDeviceModel(onProgress) {
  const m = hybridModel({ mode: InferenceMode.ONLY_ON_DEVICE, cloudModel: CONFIG_DEFAULTS.cloud_model_light });
  await m.initializeDeviceModel(onProgress);
}

// ---------- Firestore: shared verdict cache ----------

const db = getFirestore(app);

export function verdictId(name, version) {
  return `${encodeURIComponent(name)}@${version}`;
}

export async function readVerdict(name, version) {
  const snap = await getDoc(doc(db, 'verdicts', verdictId(name, version)));
  return snap.exists() ? snap.data() : null;
}

export async function writeVerdict(name, version, deep, meta) {
  await setDoc(doc(db, 'verdicts', verdictId(name, version)), {
    name,
    version,
    schema: 1,
    deep,
    model: meta.model,
    inferenceSource: meta.inferenceSource,
    provenanceCommit: meta.provenanceCommit || null,
    previous: meta.previous || null,
    createdAt: serverTimestamp()
  });
}
