// Soru paketi yükleyici — questions/*.yaml (DESIGN.md §9.2 kararı).
// "Agentlar soru yazmada iyi değildir" (resmi skill uyarısı): paketler elle yazılır,
// elle gözden geçirilir; kod yalnızca taşır. Yeni paket → use-cases.md kontrol listesi.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './yaml-mini.js';
import { JevError } from './errors.js';

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

export function questionsDir() {
  return process.env.JEV_QUESTIONS_DIR || resolve(PKG_ROOT, 'questions');
}

export function loadPackage(route) {
  const file = resolve(questionsDir(), `${route}.yaml`);
  let pkg;
  try {
    pkg = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new JevError('JEV_E_CONFIG', `soru paketi okunamadı (${file}): ${e.message}`);
  }
  if (!pkg || typeof pkg !== 'object') throw new JevError('JEV_E_CONFIG', `soru paketi map olmalı: ${file}`);
  for (const [id, q] of Object.entries(pkg)) {
    if (!q || typeof q !== 'object' || !['choice', 'score', 'noul'].includes(q.type)) {
      throw new JevError('JEV_E_CONFIG', `soru paketi bozuk: ${route}.yaml → ${id}.type geçersiz`);
    }
  }
  return pkg;
}

// Aday başına fan-out: {relevant, role} → {f14_relevant, f14_role} gibi kimlik öneki ekler.
export function withPrefix(pkg, prefix) {
  const out = {};
  for (const [id, q] of Object.entries(pkg)) out[prefix + id] = q;
  return out;
}
