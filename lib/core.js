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
    const started = Date.now();
    const routeName = input?.route || 'adhoc';

    let routeCfg;
    try {
      routeCfg = resolveRoute(this.thresholds, routeName);
    } catch (e) {
      return this._fail(e, routeName);
    }
    try {
      validateDecideInput(input);
    } catch (e) {
      return this._fail(e, routeName);
    }

    const model = input.model || this.thresholds.defaults.model || 'jev-latest';
    const ttl =
      input.ttl_seconds !== undefined ? input.ttl_seconds : routeCfg.cacheTtlSeconds;
    const key = opts.cacheKey || contentKey({ model, state: input.state, questions: input.questions });
    const questionIds = Object.keys(input.questions);

    let outcome;
    if (ttl > 0) {
      const hit = this.cache.get(key);
      if (hit) {
        outcome = {
          ok: true,
          answers: hit.answers,
          meta: { ...hit.meta, cached: true, route: routeCfg.name },
        };
      }
    }
    if (!outcome) {
      try {
        const res = await this.client.decide(
          { state: input.state, questions: input.questions, model },
          { timeoutMs: routeCfg.requestTimeoutMs, maxRetries: routeCfg.maxRetries },
        );
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
      return { ok: true, ...outcome, meta: { ...outcome.meta, floor: routeCfg.floor, thresholds: routeCfg.thresholds } };
    }
    return { ...outcome, meta: { ...outcome.meta, mode: routeCfg.mode, verdict_suggestion: 'passthrough' } };
  }

  _fail(e, routeName) {
    const je = e instanceof JevError ? e : new JevError('JEV_E_CONFIG', String(e?.message || e));
    return { ok: false, error: je.toJSON(), meta: { route: routeName, verdict_suggestion: 'passthrough' } };
  }
}
