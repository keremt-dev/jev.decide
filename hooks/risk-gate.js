#!/usr/bin/env node
// PreToolUse risk kapısı (DESIGN.md §5) — escalate-only, fail-open.
// Claude Code / ZCode hook sözleşmesi: stdin'de {tool_name, tool_input, cwd} JSON alır.
// Çıktı kararları: passthrough (sessiz) | note (sessiz, telemetriye yazılır) | ask (permissionDecision ASK).
// Hook asla 'allow' üretmez — izin azami harness'in izin sistemindedir (monotonic safety).
// Codex PreToolUse hook'unu desteklemez; orada bu kapı çalışmaz → davranış Jev'siz olur (fail-open by design).
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DecidePipeline } from '../lib/core.js';
import { resolveRoute } from '../lib/thresholds.js';
import { loadPackage } from '../lib/questions.js';
import { signatureKey } from '../lib/cache.js';

const HOOK_ROUTE = 'hook.risk_gate';

function exitQuiet(code = 0) {
  process.exit(code);
}

function readStdinJson(maxMs) {
  return new Promise((resolvePromise) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        resolvePromise(data.trim() === '' ? null : JSON.parse(data));
      } catch {
        resolvePromise(null);
      }
    };
    const timer = setTimeout(finish, maxMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function normalizeCommand(command) {
  return command.replace(/\s+/g, ' ').trim();
}

// Zincirleme/işleçli komutlar ("ls && rm -rf") statik güvenli listeye ALINAMAZ — parçaların
// en risklisi bütün hakkında söz söylemez; bunlar Jev'e gider.
function hasChaining(sig) {
  return /[;|&<>`()\n]/.test(sig);
}

function gitStatusDirty(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  try {
    const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], {
      timeout: 1500,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.error || r.status !== 0) return null;
    return r.stdout.trim().length > 0;
  } catch {
    return null;
  }
}

// DESIGN.md §5.2 verdict matrisi — yalnızca passthrough | note | ask üretebilir.
function classifyVerdict(outcome, th) {
  if (!outcome?.ok) return 'passthrough';
  const cls = outcome.answers?.q_class ?? null;
  const conf = outcome.answers?.q_conf ?? null;
  const confYes = conf?.value === 'yes';
  // confidence yoksa (noul tarafı) probability üzerinden yorumlanır (schema §3);
  // sınıf güveni hiç yoksa floor altı kabul edilir (güvenli yön).
  let classConf = typeof cls?.confidence === 'number' ? cls.confidence : null;
  if (classConf === null && cls?.probabilities && typeof cls.probabilities === 'object') {
    const p = cls.probabilities[cls.value];
    if (typeof p === 'number') classConf = p;
  }
  if (classConf === null || classConf < th.agreement_floor) return 'passthrough'; // güven < floor
  if (cls.value === 'destructive' && classConf >= th.destructive_block) return 'ask';
  if (cls.value === 'safe' && classConf >= th.safe_note) {
    return confYes ? 'passthrough' : 'note'; // choice↔noul anlaşmazlığı → passthrough
  }
  return 'passthrough';
}

function withDeadline(promise, ms, onTimeout) {
  return new Promise((resolveP) => {
    const timer = setTimeout(() => resolveP(onTimeout()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolveP(v);
      },
      () => {
        clearTimeout(timer);
        resolveP(onTimeout());
      },
    );
  });
}

async function main() {
  const payload = await readStdinJson(2000);
  if (!payload || payload.tool_name !== 'Bash') return exitQuiet();
  const rawCommand = payload?.tool_input?.command;
  if (typeof rawCommand !== 'string' || rawCommand.trim() === '') return exitQuiet();

  let pipeline;
  let routeCfg;
  try {
    pipeline = DecidePipeline.load();
    routeCfg = resolveRoute(pipeline.thresholds, HOOK_ROUTE);
  } catch {
    return exitQuiet(); // thresholds/soru paketi yok → Jev'siz davranış (fail-open)
  }
  if (routeCfg.mode === 'off') return exitQuiet();
  const th = routeCfg.thresholds;

  const sig = normalizeCommand(rawCommand);
  const staticSafe =
    !hasChaining(sig) &&
    routeCfg.staticSafePatterns.some((p) => {
      try {
        return new RegExp(p).test(sig);
      } catch {
        return false;
      }
    });

  if (staticSafe) {
    // (1) ucuz öneşleme: Jev'e hiç gitmez, telemetriye yalnız bir satır
    pipeline.telemetry.logDecision({
      route: HOOK_ROUTE,
      question_ids: [],
      answers: {},
      verdict: 'passthrough',
      mode: routeCfg.mode,
      cached: false,
      latency_ms: 0,
      reason: 'static_safe',
    });
    return exitQuiet();
  }

  const questions = loadPackage(HOOK_ROUTE);
  const state = {
    command: sig,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
    git_dirty: gitStatusDirty(payload.cwd),
  };
  const cacheKey = signatureKey(sig); // (2) komut imzası cache'i
  const deadlineMs = routeCfg.requestTimeoutMs + 2000;

  const outcome = await withDeadline(
    pipeline.run(
      { state, questions, route: HOOK_ROUTE },
      { cacheKey, verdictOf: (o) => classifyVerdict(o, th) },
    ),
    deadlineMs,
    () => {
      const fallback = {
        ok: false,
        error: { code: 'JEV_E_HOOK_TIMEOUT', message: `hook tavanı ${deadlineMs}ms aşıldı` },
        meta: { route: HOOK_ROUTE },
      };
      try {
        pipeline.telemetry.logDecision({
          route: HOOK_ROUTE,
          question_ids: Object.keys(questions),
          answers: {},
          verdict: 'passthrough',
          mode: routeCfg.mode,
          cached: false,
          latency_ms: deadlineMs,
          error: 'JEV_E_HOOK_TIMEOUT',
        });
      } catch {
        // telemetri hatası akışı değiştirmez
      }
      return fallback;
    },
  );

  if (routeCfg.mode === 'shadow') return exitQuiet(); // would= telemetride; akışa sıfır etki

  const verdict = outcome.ok ? classifyVerdict(outcome, th) : 'passthrough';
  if (verdict === 'ask') {
    const conf = outcome.answers?.q_class?.confidence;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ASK',
          permissionDecisionReason: `jev.decide risk gate: destructive (güven ${conf} ≥ ${th.destructive_block}) — ek onay önerilir`,
        },
      }),
    );
  }
  // note / passthrough → çıktı yok; hook asla izin vermez, yalnızca yükseltir
  return exitQuiet();
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(() => exitQuiet()); // hook'ta yakalanmamış hata = sessiz passthrough
}
