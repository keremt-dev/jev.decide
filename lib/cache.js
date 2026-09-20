// İçerik-hash cache (docs/tool-schema.md §4).
// Anahtar: sha256(model ∥ canonical_json(state) ∥ canonical_json(questions) [, extra]).
// Hook route'u için ayrıca komut imzası anahtarı (signatureKey) — yol/glob normalize edilmiş komut.
// Süreç içi Map + .jev/cache.json dosya kalıcılığı (hook kısa ömürlü süreç olduğundan gerekli).
// Tüm dosya işlemleri best-effort: cache bozukluğu akışı asla bozmaz (fail-open).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function contentKey({ model = 'jev-latest', state, questions, extra = '' }) {
  return createHash('sha256')
    .update([model, canonicalJson(state), canonicalJson(questions), extra].join('\u0000'))
    .digest('hex');
}

export function signatureKey(signature) {
  return createHash('sha256').update(`hook-sig\u0000${signature}`).digest('hex');
}

export class Cache {
  constructor({ dir = null, now = Date.now } = {}) {
    this.now = now;
    this.mem = new Map();
    this.file = dir ? resolve(dir, 'cache.json') : null;
    this.loaded = false;
  }

  get(key) {
    this._load();
    const entry = this.mem.get(key);
    if (!entry) return null;
    if (entry.expires !== null && entry.expires <= this.now()) {
      this.mem.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlSeconds) {
    this._load();
    this.mem.set(key, {
      value,
      expires: ttlSeconds > 0 ? this.now() + ttlSeconds * 1000 : null,
    });
    this._save();
  }

  clear() {
    this.mem.clear();
    this._save();
  }

  _load() {
    if (this.loaded || !this.file) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) {
        if (!this.mem.has(k)) this.mem.set(k, v);
      }
    } catch {
      // dosya yok/bozuk → boş başla
    }
  }

  _save() {
    if (!this.file) return;
    try {
      const now = this.now();
      const out = {};
      for (const [k, e] of this.mem) {
        if (e.expires !== null && e.expires <= now) continue;
        out[k] = e;
      }
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(out));
    } catch {
      // yazma hatası sessizce yutulur
    }
  }
}
