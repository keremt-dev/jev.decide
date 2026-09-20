import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache, canonicalJson, contentKey } from '../lib/cache.js';

test('canonicalJson: anahtar sırası bağımsız, diziler sıra korur', () => {
  const a = { b: 1, a: { d: 2, c: [3, 1] } };
  const b = { a: { c: [3, 1], d: 2 }, b: 1 };
  assert.equal(canonicalJson(a), '{"a":{"c":[3,1],"d":2},"b":1}');
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(null), 'null');
});

test('contentKey: içerik aynıysa anahtar aynı, farklıysa farklı; extra kaynak ayrımı yapar', () => {
  const args = { model: 'jev-latest', state: 's', questions: { q: { type: 'noul', instructions: 'x' } } };
  const k1 = contentKey(args);
  const k2 = contentKey({ ...args, questions: { q: { instructions: 'x', type: 'noul' } } }); // anahtar sırası farklı
  assert.equal(k1, k2);
  assert.notEqual(k1, contentKey({ ...args, state: 'farklı' }));
  assert.notEqual(contentKey(args), contentKey({ ...args, extra: 'src:mock|base:' })); // B04: kaynak etiketi
  assert.match(k1, /^[0-9a-f]{64}$/);
});

test('Cache: TTL dolunca isabet düşer (enjekte edilen saat)', () => {
  let t = 1000;
  const c = new Cache({ dir: null, now: () => t });
  c.set('k', { v: 1 }, 10); // 10s → 1000+10000
  assert.deepEqual(c.get('k'), { v: 1 });
  t = 10_999;
  assert.deepEqual(c.get('k'), { v: 1 });
  t = 11_000;
  assert.equal(c.get('k'), null);
});

test('Cache: TTL 0 → süresiz', () => {
  let t = 5000;
  const c = new Cache({ dir: null, now: () => t });
  c.set('k', 'v', 0);
  t = 9_999_999;
  assert.equal(c.get('k'), 'v');
});

test('Cache: dosya kalıcılığı — yeni örnek aynı dosyadan okur, süresi geçen düşer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-cache-'));
  try {
    let t = Date.now();
    const c1 = new Cache({ dir, now: () => t });
    c1.set('sig', { answers: { q: 1 } }, 3600);
    assert.ok(existsSync(join(dir, 'cache.json')));

    const c2 = new Cache({ dir, now: () => t }); // yeni örnek = yeni "süreç"
    assert.deepEqual(c2.get('sig'), { answers: { q: 1 } });

    // kısa TTL'li girdi süresi dolunca bir sonraki kayıtta dosyadan da düşer
    c2.set('eski', 'x', 1);
    t += 2000;
    c2.set('tetik', 'y', 60); // _save tetiklenir, 'eski' süresi geçtiği için yazılmaz
    const raw = JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8'));
    assert.ok(!('eski' in raw));
    assert.ok('sig' in raw);
    assert.ok('tetik' in raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Cache: bozuk dosya sessizce yok sayılır (fail-open)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-cache-'));
  try {
    writeFileSync(join(dir, 'cache.json'), '{bu geçersiz');
    const c = new Cache({ dir });
    assert.equal(c.get('yok'), null);
    c.set('yeni', 1, 60);
    assert.equal(c.get('yeni'), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
