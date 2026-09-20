// Eşik/mode yükleyici — tek kaynak: docs/thresholds.yaml (DESIGN.md §2).
// Kod ve SKILL.md sabit eşik içermez; her şey buradan okunur.
// JEV_THRESHOLDS ortam değişkeni dosya yolunu geçersiz kılar (test/dağıtım için).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './yaml-mini.js';
import { JevError } from './errors.js';

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const MODES = new Set(['off', 'shadow', 'active']);

export class ThresholdError extends JevError {
  constructor(message, code = 'JEV_E_CONFIG') {
    super(code, message);
    this.name = 'ThresholdError';
  }
}

export function thresholdsPath(explicit) {
  if (explicit) return explicit;
  if (process.env.JEV_THRESHOLDS) return process.env.JEV_THRESHOLDS;
  return resolve(PKG_ROOT, 'docs', 'thresholds.yaml');
}

export function loadThresholds(explicit) {
  const p = thresholdsPath(explicit);
  let th;
  try {
    th = parseYaml(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new ThresholdError(`thresholds.yaml okunamadı (${p}): ${e.message}`);
  }
  if (!th || typeof th !== 'object' || Array.isArray(th)) {
    throw new ThresholdError(`thresholds.yaml bir map olmalı (${p})`);
  }
  if (th.version !== 1) throw new ThresholdError(`Desteklenmeyen thresholds sürümü: ${th.version}`);
  if (!th.defaults || typeof th.defaults !== 'object') throw new ThresholdError("'defaults' bloğu eksik");
  if (!th.routes || typeof th.routes !== 'object') throw new ThresholdError("'routes' bloğu eksik");
  for (const [name, route] of Object.entries(th.routes)) {
    if (!route || typeof route !== 'object') throw new ThresholdError(`route '${name}' bir map olmalı`);
    if (!MODES.has(route.mode)) {
      throw new ThresholdError(`route '${name}': mode off|shadow|active olmalı (verilen: ${JSON.stringify(route.mode)})`);
    }
    if (!route.thresholds || typeof route.thresholds !== 'object') {
      throw new ThresholdError(`route '${name}': 'thresholds' bloğu eksik`);
    }
  }
  if (!th.routes.adhoc) throw new ThresholdError("routes içinde 'adhoc' zorunlu (route verilmezse bu kullanılır)");
  th._path = p;
  return th;
}

// Route yapılandırmasını defaults ile birleştirir. Bilinmeyen route hata —
// sessizce adhoc'e düşmek eşik karışıklığı yaratır.
export function resolveRoute(th, routeName) {
  const name = routeName && routeName !== '' ? routeName : 'adhoc';
  const route = th.routes[name];
  if (!route) {
    throw new ThresholdError(
      `Bilinmeyen route: '${name}' — thresholds.yaml routes içinde tanımlı olmalı`,
      'JEV_E_UNKNOWN_ROUTE',
    );
  }
  return {
    name,
    mode: route.mode,
    cacheTtlSeconds: route.cache_ttl_seconds ?? th.defaults.cache_ttl_seconds ?? 3600,
    requestTimeoutMs: route.request_timeout_ms ?? th.defaults.request_timeout_ms ?? 5000,
    maxRetries: route.max_retries ?? th.defaults.max_retries ?? 3,
    floor: route.floor ?? th.defaults.floor ?? 0.6,
    thresholds: route.thresholds || {},
    staticSafePatterns: route.static_safe_patterns || [],
    rollout: route.rollout || null,
  };
}
