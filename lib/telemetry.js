// Telemetri + kalibrasyon kaydı (DESIGN.md §6, docs/tool-schema.md §5).
// KURAL: state ve soru metinleri ASLA yazılmaz — yalnızca soru kimlikleri ve yanıt özetleri.
// Tüm işlemler best-effort: telemetri hatası karar akışını bozmaz.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export class Telemetry {
  constructor({ dir = null, now = Date.now } = {}) {
    this.now = now;
    this.telemetryFile = dir ? resolve(dir, 'telemetry.jsonl') : null;
    this.calibrationFile = dir ? resolve(dir, 'calibration.jsonl') : null;
  }

  // entry: {route, question_ids, answers, verdict?, outcome?, request_id?, latency_ms?,
  //         cached?, mode?, model?, error?, reason?}
  logDecision(entry) {
    const answers = {};
    for (const [id, a] of Object.entries(entry.answers || {})) {
      answers[id] =
        a && typeof a === 'object' ? { value: a.value, confidence: a.confidence ?? null } : null;
    }
    this._append(this.telemetryFile, {
      ts: new Date(this.now()).toISOString(),
      route: entry.route ?? null,
      question_ids: entry.question_ids || [],
      answers,
      verdict: entry.verdict ?? null,
      outcome: entry.outcome ?? null,
      request_id: entry.request_id ?? null,
      latency_ms: entry.latency_ms ?? null,
      cached: Boolean(entry.cached),
      mode: entry.mode || 'off',
      model: entry.model ?? null,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
    });
  }

  // Route başına ilk N karar kalibrasyona yazılır (firstmate deseni: sınıf sayacı + örneklem).
  recordCalibration(route, payload, firstN = 200) {
    if (!this.calibrationFile) return;
    try {
      let count = 0;
      if (existsSync(this.calibrationFile)) {
        for (const line of readFileSync(this.calibrationFile, 'utf8').split('\n')) {
          if (line.trim() === '') continue;
          try {
            if (JSON.parse(line).route === route) count += 1;
          } catch {
            // bozuk satır sayılmaz
          }
        }
      }
      if (count >= firstN) return;
      this._append(this.calibrationFile, { ts: new Date(this.now()).toISOString(), route, ...payload });
    } catch {
      // kalibrasyon kaybı akışı bozmaz
    }
  }

  // Karar sonrası "sonucu ne oldu" kaydı (kalibrasyon döngüsünün ikinci yarısı).
  recordOutcome(route, requestId, outcome) {
    this._append(this.calibrationFile, {
      ts: new Date(this.now()).toISOString(),
      route,
      request_id: requestId,
      outcome,
    });
  }

  _append(file, obj) {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(obj)}\n`);
    } catch {
      // telemetri yazılamadı → sessiz geç
    }
  }
}
