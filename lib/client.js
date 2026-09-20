// Jev (TypeSafe.ai "System One") istemcisi — POST /v1/systemone sarmalayıcısı.
// Hata semantiği (docs/tool-schema.md §3):
//   422        → JEV_E_BAD_REQUEST (asla retry — çağıran hatası)
//   429 / 529  → retry: max N, üstel backoff, retry-after'e saygı; tükenirse JEV_E_RATE_LIMIT
//   401 / 403  → JEV_E_AUTH (retry yok)
//   diğer 5xx / ağ / timeout → JEV_E_UNAVAILABLE (retry yok — karar katmanı idempotent değilse gecikme katlanır)
// Mock modu (JEV_MOCK=1): HTTP yerine deterministik sahte yanıt + JEV_MOCK_DELAY_MS gecikme
// enjeksiyonu; JEV_MOCK_FORCE ile yanıt başına soru bazlı geçersiz kılma (shadow testleri için).
// Anahtar: JEV_API ortam değişkeni (yeğlenen), TYPESAFE_API_KEY (eski yedek). argv'ye/repo'ya asla.
import { createHash } from 'node:crypto';
import { canonicalJson } from './cache.js';
import { JevError } from './errors.js';

const RETRYABLE_STATUS = new Set([429, 529]);
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 3;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function resolveEnvConfig(env = process.env) {
  let mockForce = null;
  if (env.JEV_MOCK_FORCE) {
    try {
      mockForce = JSON.parse(env.JEV_MOCK_FORCE);
    } catch {
      mockForce = null; // bozuk JSON sessizce yok sayılır — hook asla bunun yüzünden düşmez
    }
  }
  return {
    apiKey: env.JEV_API || env.TYPESAFE_API_KEY || null,
    baseUrl: (env.JEV_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/, ''),
    mock: env.JEV_MOCK === '1',
    mockDelayMs: Math.max(0, Number.parseInt(env.JEV_MOCK_DELAY_MS || '0', 10) || 0),
    mockForce,
  };
}

export class JevClient {
  constructor({ config = {}, fetchImpl = fetch, sleep = defaultSleep, now = Date.now } = {}) {
    this.cfg = { ...resolveEnvConfig(), ...config };
    this.cfg.baseUrl = this.cfg.baseUrl.replace(/\/+$/, ''); // config override'ında da normalize
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.now = now;
  }

  get mockMode() {
    return Boolean(this.cfg.mock);
  }

  async decide({ state, questions, model }, { timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES } = {}) {
    if (this.mockMode) {
      const out = await this._mockDecide({ state, questions, model });
      return this._validateResponse('mock', questions, out);
    }
    if (!this.cfg.apiKey) {
      throw new JevError('JEV_E_AUTH', 'API anahtarı yok — JEV_API ortam değişkeni bekleniyor');
    }
    // timeoutMs = TOPLAM süre bütçesi: denemeler + backoff beklemeleri dahil (B08).
    // Tek bir deneme de kalan bütçeyle sınırlanır; bütçe bitince retry durur.
    const deadline = this.now() + timeoutMs;
    const started = this.now();
    let lastRetriable = false;
    let lastStatus = null;
    for (let attempt = 1; ; attempt++) {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        if (lastRetriable) {
          throw new JevError('JEV_E_RATE_LIMIT', `${timeoutMs}ms toplam bütçe içinde ${lastStatus} aşılamadı`, {
            retryable: true,
            status: lastStatus,
          });
        }
        throw new JevError('JEV_E_UNAVAILABLE', `Zaman bütçesi (${timeoutMs}ms) aşıldı`);
      }
      try {
        const out = await this._fetchOnce({ state, questions, model }, remaining);
        out.meta.latency_ms = Math.max(0, Math.round(this.now() - started));
        return this._validateResponse(`${this.cfg.baseUrl}/v1/systemone`, questions, out);
      } catch (e) {
        if (e instanceof JevError && RETRYABLE_STATUS.has(e.status) && attempt <= maxRetries) {
          lastRetriable = true;
          lastStatus = e.status;
          const backoff = Math.min(8000, 400 * 2 ** (attempt - 1));
          const waitMs = Math.min(Math.max(e.retryAfterMs ?? 0, backoff), deadline - this.now());
          if (waitMs <= 0) {
            throw new JevError('JEV_E_RATE_LIMIT', `Bütçe tükendi — ${e.status} hâlâ sürüyor (toplam ${timeoutMs}ms)`, {
              retryable: true,
              status: e.status,
            });
          }
          await this.sleep(waitMs);
          continue;
        }
        if (e instanceof JevError && RETRYABLE_STATUS.has(e.status)) {
          throw new JevError('JEV_E_RATE_LIMIT', `${maxRetries} retry sonrasında hâlâ ${e.status}`, {
            retryable: true,
            status: e.status,
          });
        }
        if (e instanceof JevError) throw e;
        // ağ hatası / abort(timeout) → retry yok (tasarım kararı, schema §3)
        throw new JevError('JEV_E_UNAVAILABLE', `Ağ/timeout hatası: ${e?.message || e}`);
      }
    }
  }

  // B07: HTTP 200 ≠ geçerli yanıt. Cache'e yazılmadan önce istenen soruların tamamının
  // şemaya uygun yanıt aldığı doğrulanır; eksik/bozuk yanıt hata zarfına döner (retry yok).
  _validateResponse(source, questions, out) {
    const errs = [];
    for (const [id, q] of Object.entries(questions)) {
      const a = out.answers?.[id];
      if (!a || typeof a !== 'object') {
        errs.push(`${id}: yanıt yok`);
        continue;
      }
      if (a.value === undefined || a.value === null) {
        errs.push(`${id}: value yok`);
      } else if (q.type === 'choice') {
        if (!(a.value in (q.criteria || {}))) errs.push(`${id}: '${a.value}' seçenekler arasında değil`);
      } else if (q.type === 'score') {
        const levels = q.criteria || [];
        const okLevel =
          levels.includes(a.value) || (Number.isInteger(a.value) && levels[a.value] !== undefined);
        if (!okLevel) errs.push(`${id}: '${a.value}' düzeyler arasında değil`);
      } else if (q.type === 'noul' && !['yes', 'no'].includes(a.value)) {
        errs.push(`${id}: noul yanıtı yes|no olmalı`);
      }
      if (a.confidence != null && !(typeof a.confidence === 'number' && a.confidence >= 0 && a.confidence <= 1)) {
        errs.push(`${id}: confidence [0,1] dışında`);
      }
      if (a.probabilities != null) {
        if (typeof a.probabilities !== 'object') {
          errs.push(`${id}: probabilities nesne olmalı`);
        } else {
          for (const [k, p] of Object.entries(a.probabilities)) {
            if (typeof p !== 'number' || p < 0 || p > 1) errs.push(`${id}.probabilities.${k}: [0,1] dışında`);
          }
        }
      }
    }
    if (errs.length > 0) {
      throw new JevError('JEV_E_BAD_RESPONSE', `Eksik/bozuk yanıt (${source}): ${errs.join('; ').slice(0, 300)}`);
    }
    return out;
  }

  // Açılışta bir kez: anahtar doğrulama + sürüm yoklama (schema §6). Hata fırlatır; çağıran loglar, akış sürer.
  // B08/küçük-2: süre sınırı vardır; `models:[{name:...}]` tel biçimi de çözülür.
  async probeModels({ timeoutMs = 5000 } = {}) {
    if (this.mockMode) return { mock: true, models: ['jev-mock-1.0'] };
    if (!this.cfg.apiKey) throw new JevError('JEV_E_AUTH', 'API anahtarı yok — JEV_API bekleniyor');
    let res;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${this.cfg.apiKey}` },
        signal: controller.signal,
      });
    } catch (e) {
      throw new JevError('JEV_E_UNAVAILABLE', `GET /v1/models ağ hatası: ${e?.message || e}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw new JevError('JEV_E_AUTH', `Anahtar reddedildi (GET /v1/models → ${res.status})`, { status: res.status });
    }
    if (!res.ok) {
      throw new JevError('JEV_E_UNAVAILABLE', `GET /v1/models → ${res.status}`, { status: res.status });
    }
    const body = await res.json().catch(() => ({}));
    const models = (body.data ?? body.models ?? [])
      .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? null))
      .filter(Boolean);
    return { models };
  }

  async _fetchOnce({ state, questions, model }, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
          'x-typesafe-client': 'jev.decide/0.1',
        },
        body: JSON.stringify(model ? { state, questions, model } : { state, questions }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw this._mapHttpError(res.status, text, res.headers);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new JevError('JEV_E_UNAVAILABLE', `Yanıt JSON değil (HTTP ${res.status})`, { status: res.status });
      }
      const requestId =
        body.request_id ?? res.headers?.get?.('x-typesafe-request-id') ?? null;
      return {
        // API doğal biçimi: choice→{choice,confidence,probabilities}, noul→{noul:p}.
        // Sözleşmemiz (tool-schema §2): value/probabilities/confidence — normalleri burada çevir.
        answers: normalizeAnswers(body.answers),
        meta: {
          model: body.model ?? null,
          request_id: requestId,
          latency_ms: 0,
          cached: false,
          usage: body.usage ?? null,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  _mapHttpError(status, bodyText, headers) {
    let apiMessage = null;
    try {
      const b = JSON.parse(bodyText);
      apiMessage = b.error?.message ?? b.message ?? (typeof b.error === 'string' ? b.error : null);
    } catch {
      // gövde JSON değilse ham metin kullanılır (aşağıda kırpılır)
    }
    const detail = (apiMessage || bodyText || '').slice(0, 300);
    if (status === 422) {
      return new JevError('JEV_E_BAD_REQUEST', `422: ${detail || 'geçersiz istek'}`, { status });
    }
    if (status === 401 || status === 403) {
      return new JevError('JEV_E_AUTH', `${status}: anahtar geçersiz/yetkisiz — ${detail}`, { status });
    }
    if (RETRYABLE_STATUS.has(status)) {
      const ra = headers?.get?.('retry-after');
      const retryAfterMs = ra ? Math.max(0, parseFloat(ra) * 1000) : null;
      return new JevError('JEV_E_RATE_LIMITED_RESPONSE', `${status}: hız sınırı — ${detail}`, {
        status,
        retryable: true,
        retryAfterMs,
      });
    }
    return new JevError('JEV_E_UNAVAILABLE', `${status}: ${detail || 'sunucu hatası'}`, { status });
  }

  // --- Mock modu -----------------------------------------------------------

  async _mockDecide({ state, questions, model }) {
    if (this.cfg.mockDelayMs > 0) await this.sleep(this.cfg.mockDelayMs);
    const seedHex = createHash('sha256')
      .update(canonicalJson({ state, questions, model }))
      .digest('hex');
    const rnd = mulberry32(parseInt(seedHex.slice(0, 8), 16) >>> 0);
    const started = this.now();
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      const forced = this.cfg.mockForce?.[id];
      answers[id] = forced ? { ...mockAnswer(q, rnd), ...forced } : mockAnswer(q, rnd);
    }
    return {
      answers,
      meta: {
        model: 'jev-mock-1.0',
        request_id: `mock_${seedHex.slice(0, 12)}`,
        latency_ms: Math.max(0, Math.round(this.now() - started)),
        cached: false,
        usage: { input_tokens: 0, output_tokens: 0 },
        mock: true,
      },
    };
  }
}

// API doğal yanıtını MCP sözleşmesine normalleştir (tool-schema.md §2/§6):
//   choice → value=<choice alanı>            noul → value=yes|no (p≥0.5), probabilities={yes,no}
//   score  → value=<score alanı>             confidence yoksa null (noul'da beklenen durum)
export function normalizeAnswers(rawAnswers) {
  const out = {};
  for (const [id, raw] of Object.entries(rawAnswers ?? {})) {
    if (!raw || typeof raw !== 'object') {
      out[id] = raw ?? null;
      continue;
    }
    const a = { value: null, probabilities: raw.probabilities ?? null, confidence: typeof raw.confidence === 'number' ? raw.confidence : null };
    if (raw.choice !== undefined) {
      a.value = raw.choice;
    } else if (raw.score !== undefined) {
      a.value = raw.score;
    } else if (typeof raw.noul === 'number') {
      // B09: evet/hayır kararı HAM olasılıktan verilir; yuvarlama yalnız gösterim içindir.
      const p = raw.noul;
      a.value = p >= 0.5 ? 'yes' : 'no';
      a.probabilities = { yes: Math.round(p * 1000) / 1000, no: Math.round((1 - p) * 1000) / 1000 };
    } else {
      a.value = raw.value ?? null; // sözleşme biçiminde gelen eski/uyumlu yanıtlar
    }
    out[id] = a;
  }
  return out;
}

function mockAnswer(q, rnd) {
  if (q.type === 'choice') {
    const opts = Object.keys(q.criteria || {});
    const nonEscape = opts.filter((o) => o !== 'other' && o !== 'none_of_the_above');
    const escape = opts.find((o) => o === 'other' || o === 'none_of_the_above');
    let value;
    if (nonEscape.length > 0 && rnd() < 0.9) {
      value = nonEscape[Math.floor(rnd() * nonEscape.length) % nonEscape.length];
    } else {
      value = escape ?? opts[0];
    }
    const probabilities = {};
    const top = 0.5 + rnd() * 0.35;
    let rest = 1 - top;
    const others = opts.filter((o) => o !== value);
    for (const o of others) {
      const p = others.indexOf(o) === others.length - 1 ? rest : rest * (0.3 + rnd() * 0.4);
      probabilities[o] = Math.round(p * 1000) / 1000;
      rest -= probabilities[o];
    }
    probabilities[value] = Math.round(top * 1000) / 1000;
    return { value, probabilities, confidence: Math.round((0.55 + rnd() * 0.42) * 1000) / 1000 };
  }
  if (q.type === 'score') {
    const levels = q.criteria || [];
    const idx = Math.min(levels.length - 1, Math.floor(rnd() * levels.length));
    const probabilities = levels.map((_, i) => (i === idx ? 0.6 : 0.4 / (levels.length - 1)));
    return {
      value: levels[idx],
      probabilities,
      confidence: Math.round((0.55 + rnd() * 0.42) * 1000) / 1000,
    };
  }
  // noul — confidence yok (null); yorum probability üzerinden (schema §3)
  const yes = rnd() < 0.5;
  const p = 0.6 + rnd() * 0.35;
  return {
    value: yes ? 'yes' : 'no',
    probabilities: { yes: Math.round((yes ? p : 1 - p) * 1000) / 1000, no: Math.round((yes ? 1 - p : p) * 1000) / 1000 },
    confidence: null,
  };
}

// Deterministik PRNG (mulberry32) — aynı girdi her zaman aynı sahte yanıtı üretir.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
