// Karar hattı: doğrula → route çöz → cache → Jev çağrısı → telemetri (+ verdict) → kalibrasyon.
// Hem MCP `decide` aracı hem PreToolUse hook'u bu hattı paylaşır.
// Hatalar fırlatılmaz; {ok:false, error, meta:{verdict_suggestion:'passthrough'}} zarfı döner (fail-open).
import { loadThresholds, resolveRoute } from './thresholds.js';
import { validateDecideInput } from './validate.js';
import { Cache, contentKey } from './cache.js';
import { Telemetry } from './telemetry.js';
import { JevClient } from './client.js';
import { JevError } from './errors.js';

// Çalışma dizini: JEV_STATE_DIR (mutlak) > thresholds telemetry_dir (cwd'ye göreli).
function stateDir(thresholds) {
  if (process.env.JEV_STATE_DIR) return process.env.JEV_STATE_DIR;
  return thresholds?.defaults?.telemetry_dir || '.jev';
}

// B04: cache anahtarı kararın KAYNAĞINI da kapsar — mock sonuçlar canlı modda (ve tersi)
// kullanılamaz; baseUrl değişimi de yeni anahtar üretir.
function sourceTag(client) {
  const mock = client?.mockMode ? 'mock' : 'live';
  const base = client?.cfg?.baseUrl ?? '';
  // Önceki doğrulama/yuvarlama/komut normalizasyonuyla üretilmiş kayıtları kullanma.
  return `schema:2|src:${mock}|base:${base}`;
}

export class DecidePipeline {
  constructor({ thresholds, client, cache, telemetry, fetchImpl, sleep, now } = {}) {
    if (!thresholds) throw new JevError('JEV_E_CONFIG', 'DecidePipeline: thresholds zorunlu');
    this.thresholds = thresholds;
    this.client = client || new JevClient({ fetchImpl, sleep, now });
    const dir = stateDir(thresholds);
    this.cache = cache || new Cache({ dir });
    this.telemetry = telemetry || new Telemetry({ dir });
  }

  static load(opts = {}) {
    return new DecidePipeline({ thresholds: loadThresholds(opts.thresholdsPath), ...opts });
  }

  // input: {state, questions, route?, model?, ttl_seconds?}
  // opts:  {cacheKey?}        — hook komut-imzası anahtarı gibi açık anahtar
  //        {verdictOf?}       — (outcome) => 'passthrough'|'note'|'ask'|... telemetriye yazılır
  async run(input, opts = {}) {
    if (opts.signal?.aborted) return this._fail(new JevError('JEV_E_CANCELLED', 'İstek iptal edildi'), input?.route || 'adhoc');
    const started = Date.now();
    const routeName = input?.route || 'adhoc';

    let routeCfg;
    try {
      routeCfg = resolveRoute(this.thresholds, routeName);
    } catch (e) {
      return this._fail(e, routeName);
    }
    let valid;
    try {
      valid = validateDecideInput(input);
    } catch (e) {
      return this._fail(e, routeName);
    }

    // B06: mode: off → çağrı yok, kayıt yok (thresholds.yaml: "off (kayıt yok)");
    // çağıran fail-open zarfıyla Jev'siz davranışa döner.
    if (routeCfg.mode === 'off') {
      return {
        ok: false,
        error: {
          code: 'JEV_E_ROUTE_OFF',
          message: `route '${routeCfg.name}' kapalı (mode: off) — Jev'siz davranış`,
          retryable: false,
        },
        meta: { route: routeCfg.name, mode: 'off', verdict_suggestion: 'passthrough' },
      };
    }

    const model = input.model || this.thresholds.defaults.model || 'jev-latest';
    const ttl =
      input.ttl_seconds !== undefined ? input.ttl_seconds : routeCfg.cacheTtlSeconds;
    // B05: anahtar state (komut+cwd+git_dirty) + model + soru paketi + kaynak etiketini kapsar.
    const key =
      opts.cacheKey ||
      contentKey({ model, state: input.state, questions: input.questions, extra: sourceTag(this.client) });
    const questionIds = Object.keys(input.questions);

    let outcome;
    if (ttl > 0) {
      const hit = this.cache.get(key);
      if (hit) {
        outcome = {
          ok: true,
          answers: hit.answers,
          meta: { ...hit.meta, cached: true, route: routeCfg.name, mode: routeCfg.mode, warnings: valid.warnings },
        };
      }
    }
    if (!outcome) {
      try {
        const res = await this.client.decide(
          { state: input.state, questions: input.questions, model },
          { timeoutMs: routeCfg.requestTimeoutMs, maxRetries: routeCfg.maxRetries, signal: opts.signal },
        );
        if (opts.signal?.aborted) throw new JevError('JEV_E_CANCELLED', 'İstek iptal edildi');
        if (ttl > 0) this.cache.set(key, { answers: res.answers, meta: res.meta }, ttl);
        outcome = { ok: true, answers: res.answers, meta: { ...res.meta, cached: false, route: routeCfg.name } };
      } catch (e) {
        const je = e instanceof JevError ? e : new JevError('JEV_E_UNAVAILABLE', String(e?.message || e));
        outcome = {
          ok: false,
          error: je.toJSON(),
          meta: { route: routeCfg.name, latency_ms: Date.now() - started },
        };
      }
    }

    const verdict = opts.verdictOf ? opts.verdictOf(outcome) : null;
    this.telemetry.logDecision({
      route: routeCfg.name,
      question_ids: questionIds,
      answers: outcome.answers || {},
      verdict,
      request_id: outcome.meta?.request_id ?? null,
      latency_ms: outcome.meta?.latency_ms ?? Date.now() - started,
      cached: Boolean(outcome.meta?.cached),
      mode: routeCfg.mode,
      model: outcome.meta?.model || model,
      ...(outcome.ok ? {} : { error: outcome.error.code }),
    });

    if (outcome.ok) {
      this.telemetry.recordCalibration(
        routeCfg.name,
        { question_ids: questionIds, answers: outcome.answers, request_id: outcome.meta.request_id },
        this.thresholds.defaults.calibration_first_n ?? 200,
      );
      return {
        ok: true,
        ...outcome,
        meta: {
          ...outcome.meta,
          mode: routeCfg.mode,
          floor: routeCfg.floor,
          thresholds: routeCfg.thresholds,
          warnings: valid.warnings,
        },
      };
    }
    return {
      ...outcome,
      meta: { ...outcome.meta, mode: routeCfg.mode, verdict_suggestion: 'passthrough' },
    };
  }

  _fail(e, routeName) {
    const je = e instanceof JevError ? e : new JevError('JEV_E_CONFIG', String(e?.message || e));
    return { ok: false, error: je.toJSON(), meta: { route: routeName, verdict_suggestion: 'passthrough' } };
  }
}
