import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadThresholds, resolveRoute } from '../lib/thresholds.js';

test('docs/thresholds.yaml yüklenir (tek kaynak)', () => {
  const th = loadThresholds();
  assert.equal(th.version, 1);
  assert.ok(th.routes['hook.risk_gate']);
  assert.ok(th.routes.adhoc);
});

test('resolveRoute: defaults birleştirme ve route override', () => {
  const th = loadThresholds();
  const r = resolveRoute(th, 'hook.risk_gate');
  assert.equal(r.name, 'hook.risk_gate');
  assert.equal(r.mode, 'shadow');
  assert.equal(r.cacheTtlSeconds, 3600); // route kendi değerini verir
  assert.equal(r.requestTimeoutMs, 5000); // defaults'tan
  assert.equal(r.maxRetries, 3);
  assert.equal(r.thresholds.destructive_block, 0.85);
  assert.equal(r.staticSafePatterns.length, 5);
  assert.equal(r.rollout.min_shadow_decisions, 50);

  const search = resolveRoute(th, 'search.triage');
  assert.equal(search.cacheTtlSeconds, 3600); // route vermedi → defaults
  assert.deepEqual(search.staticSafePatterns, []);
  assert.equal(search.rollout, null);
});

test('resolveRoute: boş route → adhoc', () => {
  const th = loadThresholds();
  assert.equal(resolveRoute(th, undefined).name, 'adhoc');
  assert.equal(resolveRoute(th, '').name, 'adhoc');
  assert.equal(resolveRoute(th, 'adhoc').mode, 'active');
});

test('resolveRoute: bilinmeyen route hata (sessiz adhoc düşüşü yok)', () => {
  const th = loadThresholds();
  assert.throws(() => resolveRoute(th, 'yok.boyle.route'), { code: 'JEV_E_UNKNOWN_ROUTE' });
});

test('bozuk dosya / eksik bloklar JEV_E_CONFIG', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-th-'));
  // denetim sırası: version → defaults → routes → route içi → adhoc
  const cases = [
    ['version: 2\ndefaults:\n  model: jev-latest\nroutes:\n  adhoc:\n    mode: shadow\n    thresholds:\n      act_on_confidence: 0.85\n', /sürüm/],
    ['version: 1\na: 1\n', /defaults/],
    ['version: 1\ndefaults:\n  model: jev-latest\nroutes:\n  r:\n    mode: belki\n    thresholds:\n      x: 1\n', /mode/],
    ['version: 1\ndefaults:\n  model: jev-latest\nroutes:\n  r:\n    mode: shadow\n', /thresholds/],
    ['version: 1\ndefaults:\n  model: jev-latest\nroutes:\n  r:\n    mode: shadow\n    thresholds:\n      x: 1\n', /adhoc/],
  ];
  for (const [content, re] of cases) {
    const p = join(dir, `t-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(p, content);
    assert.throws(() => loadThresholds(p), re, `içerik: ${JSON.stringify(content)}`);
  }
  rmSync(dir, { recursive: true, force: true });
});
