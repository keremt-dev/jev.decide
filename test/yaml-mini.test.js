import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../lib/yaml-mini.js';

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const realThresholds = readFileSync(resolve(PKG_ROOT, 'docs', 'thresholds.yaml'), 'utf8');

test('gerçek thresholds.yaml çözümlenir: defaults skalar tipleri', () => {
  const th = parse(realThresholds);
  assert.equal(th.version, 1);
  assert.equal(th.defaults.model, 'jev-latest');
  assert.equal(th.defaults.request_timeout_ms, 5000);
  assert.equal(th.defaults.max_retries, 3);
  assert.equal(th.defaults.cache_ttl_seconds, 3600);
  assert.equal(th.defaults.floor, 0.6);
  assert.equal(th.defaults.telemetry_dir, '.jev');
  assert.equal(th.defaults.calibration_first_n, 200);
});

test('gerçek thresholds.yaml: hook.risk_gate route bloğu', () => {
  const th = parse(realThresholds);
  const r = th.routes['hook.risk_gate'];
  assert.equal(r.mode, 'shadow');
  assert.equal(r.cache_ttl_seconds, 3600);
  assert.equal(r.static_safe_patterns.length, 5);
  const diffPattern = new RegExp(r.static_safe_patterns[4]);
  assert.equal(diffPattern.test('git diff --stat HEAD~1'), true);
  assert.equal(diffPattern.test("git diff '--output'=x"), false);
  assert.equal(diffPattern.test('git diff --ext-diff'), false);
  assert.equal(r.thresholds.destructive_block, 0.85);
  assert.equal(r.thresholds.safe_note, 0.9);
  assert.equal(r.thresholds.agreement_floor, 0.6);
  assert.equal(r.rollout.min_shadow_decisions, 50);
  assert.equal(r.rollout.max_mismatch_rate, 0.05);
  assert.equal(r.rollout.destructive_false_negatives_allowed, 0);
});

test('gerçek thresholds.yaml: bool, ek routes, adhoc active', () => {
  const th = parse(realThresholds);
  assert.equal(th.routes['search.triage'].mode, 'shadow');
  assert.equal(th.routes['search.triage'].thresholds.widen_on_below_floor, true);
  assert.equal(th.routes['search.triage'].thresholds.read_top_k, 5);
  assert.equal(th.routes.adhoc.mode, 'active');
  assert.equal(th.routes.adhoc.thresholds.act_on_confidence, 0.85);
});

test('tırnak içi # ve : korunur, satır sonu yorumu atılır', () => {
  const doc = [
    'a: "değer # hash"', // tırnak içindeki # yorum sayılmaz
    'b: "#önceki"', //
    'c: 1 # yorum',
    'd: "http://x:80/y"',
    'e:',
    '  - "p( |$)"',
    '  - "a: b"',
  ].join('\n');
  const v = parse(doc);
  assert.equal(v.a, 'değer # hash');
  assert.equal(v.b, '#önceki');
  assert.equal(v.c, 1);
  assert.equal(v.d, 'http://x:80/y');
  assert.deepEqual(v.e, ['p( |$)', 'a: b']);
});

test('yorum ve boşluklar: boş belge → {}', () => {
  assert.deepEqual(parse('# sadece yorum\n\n   \n'), {});
});

test('tüketilmemiş içerik / girinti azalışı reddedilir (küçük 4)', () => {
  assert.throws(() => parse('  a: 1\nb: 2'), /tüketilmemiş içerik|girinti/);
  assert.throws(() => parse('a:\n    b: 1\n  c: 2'), /tüketilmemiş içerik|girinti/);
});

test('yinelenen anahtar reddedilir', () => {
  assert.throws(() => parse('a: 1\na: 2'), /yinelenen/);
});

test('tab girinti reddedilir', () => {
  assert.throws(() => parse('a:\n\tb: 1'), /tab/);
});

test('tırnaklanmamış iki nokta içeren değer reddedilir', () => {
  assert.throws(() => parse('a: x: y'), /tırnaklanmalı/);
});

test('çok satırlı skalar (|) desteklenmez', () => {
  assert.throws(() => parse('a: |\n  satır'), /çok satırlı/);
});

test('skalar null ve boş değer', () => {
  const v = parse('a: null\nb: ~\nc:\nd:');
  assert.equal(v.a, null);
  assert.equal(v.b, null);
  assert.equal(v.c, null);
  assert.equal(v.d, null);
});

test('soru paketi YAML biçimi çözümlenir', () => {
  const pkg = parse(readFileSync(resolve(PKG_ROOT, 'questions', 'hook.risk_gate.yaml'), 'utf8'));
  assert.equal(pkg.q_class.type, 'choice');
  assert.equal(pkg.q_class.instructions, 'Bu komut çalışma dizininde veya sistemde hangi etkiyi yaratır?');
  assert.equal(pkg.q_class.criteria.safe, 'Yalnızca okur veya geçici çıktı üretir; kalıcı değişiklik yok');
  assert.ok('other' in pkg.q_class.criteria);
  assert.equal(pkg.q_conf.type, 'noul');
  assert.equal(pkg.q_conf.criteria, undefined);
});
