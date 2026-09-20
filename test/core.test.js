import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecidePipeline } from '../lib/core.js';
import { JevClient } from '../lib/client.js';
import { loadThresholds } from '../lib/thresholds.js';

const questions = {
  q1: {
    type: 'choice',
    instructions: 'Bu dosya relevant mı?',
    criteria: { relevant: 'İlgili', other: 'Değil' },
  },
};

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'jev-core-'));
}

function mockPipeline(dir, extraClientConfig = {}) {
  const client = new JevClient({ config: { mock: true, ...extraClientConfig } });
  const prev = process.env.JEV_STATE_DIR;
  process.env.JEV_STATE_DIR = dir;
  const pipeline = new DecidePipeline({ thresholds: loadThresholds(), client });
  if (prev === undefined) delete process.env.JEV_STATE_DIR;
  else process.env.JEV_STATE_DIR = prev;
  return pipeline;
}

function readJsonl(dir, name) {
  const p = join(dir, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

test('başarı: answers + meta (route/floor/thresholds), telemetri ve kalibrasyon yazılır', () => {
  const dir = freshDir();
  try {
    const p = mockPipeline(dir);
    const out = p.run({ state: 'görev bağlamı', questions });
    return Promise.resolve(out).then((o) => {
      assert.equal(o.ok, true);
      assert.equal(o.meta.route, 'adhoc');
      assert.equal(o.meta.cached, false);
      assert.equal(o.meta.mock, true);
      assert.equal(typeof o.meta.floor, 'number');
      assert.equal(o.meta.thresholds.act_on_confidence, 0.85);

      const tel = readJsonl(dir, 'telemetry.jsonl');
      assert.equal(tel.length, 1);
      assert.equal(tel[0].route, 'adhoc');
      assert.equal(tel[0].mode, 'active');
      assert.deepEqual(tel[0].question_ids, ['q1']);
      assert.equal(tel[0].answers.q1.value !== undefined, true);
      assert.equal(tel[0].model, 'jev-mock-1.0');

      const cal = readJsonl(dir, 'calibration.jsonl');
      assert.equal(cal.length, 1);
      assert.equal(cal[0].route, 'adhoc');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache: aynı girdi ikinci çağrıda isabet — istemci yalnız bir kez çağrılır', async () => {
  const dir = freshDir();
  try {
    let calls = 0;
    const client = {
      cfg: { mock: false },
      mockMode: false,
      async decide() {
        calls += 1;
        return {
          answers: { q1: { value: 'relevant', confidence: 0.9 } },
          meta: { model: 'jev-x', request_id: 'req_1', latency_ms: 10, cached: false, usage: null },
        };
      },
    };
    const prev = process.env.JEV_STATE_DIR;
    process.env.JEV_STATE_DIR = dir;
    const p = new DecidePipeline({ thresholds: loadThresholds(), client });
    if (prev === undefined) delete process.env.JEV_STATE_DIR;
    else process.env.JEV_STATE_DIR = prev;

    const o1 = await p.run({ state: 's', questions });
    const o2 = await p.run({ state: 's', questions });
    assert.equal(calls, 1);
    assert.equal(o1.meta.cached, false);
    assert.equal(o2.meta.cached, true);
    assert.deepEqual(o2.answers, o1.answers);

    const tel = readJsonl(dir, 'telemetry.jsonl');
    assert.equal(tel.length, 2);
    assert.equal(tel[1].cached, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ttl_seconds: 0 → cache yok, istemci her seferinde çağrılır', async () => {
  const dir = freshDir();
  try {
    let calls = 0;
    const client = {
      cfg: {},
      mockMode: false,
      async decide() {
        calls += 1;
        return { answers: {}, meta: { model: 'm', request_id: 'r', latency_ms: 1, cached: false } };
      },
    };
    const prev = process.env.JEV_STATE_DIR;
    process.env.JEV_STATE_DIR = dir;
    const p = new DecidePipeline({ thresholds: loadThresholds(), client });
    if (prev === undefined) delete process.env.JEV_STATE_DIR;
    else process.env.JEV_STATE_DIR = prev;

    await p.run({ state: 's', questions, ttl_seconds: 0 });
    await p.run({ state: 's', questions, ttl_seconds: 0 });
    assert.equal(calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doğrulama hatası → ok:false zarfı + verdict_suggestion passthrough, HTTPye gitmez', async () => {
  const dir = freshDir();
  try {
    let calls = 0;
    const client = { cfg: {}, mockMode: false, async decide() { calls += 1; } };
    const prev = process.env.JEV_STATE_DIR;
    process.env.JEV_STATE_DIR = dir;
    const p = new DecidePipeline({ thresholds: loadThresholds(), client });
    if (prev === undefined) delete process.env.JEV_STATE_DIR;
    else process.env.JEV_STATE_DIR = prev;

    const bad = { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } }; // kaçış yok
    const out = await p.run({ state: 's', questions: { q: bad } });
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'JEV_E_NO_ESCAPE');
    assert.equal(out.meta.verdict_suggestion, 'passthrough');
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bilinmeyen route → JEV_E_UNKNOWN_ROUTE zarfı', async () => {
  const dir = freshDir();
  try {
    const p = mockPipeline(dir);
    const out = await p.run({ state: 's', questions, route: 'yok.böyle' });
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'JEV_E_UNKNOWN_ROUTE');
    assert.equal(out.meta.verdict_suggestion, 'passthrough');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('istemci hatası → ok:false, telemetriye error kodu, verdictOf uygulanır', async () => {
  const dir = freshDir();
  try {
    const { JevError } = await import('../lib/errors.js');
    const client = {
      cfg: {},
      mockMode: false,
      async decide() {
        throw new JevError('JEV_E_AUTH', 'anahtar yok');
      },
    };
    const prev = process.env.JEV_STATE_DIR;
    process.env.JEV_STATE_DIR = dir;
    const p = new DecidePipeline({ thresholds: loadThresholds(), client });
    if (prev === undefined) delete process.env.JEV_STATE_DIR;
    else process.env.JEV_STATE_DIR = prev;

    const out = await p.run({ state: 's', questions }, { verdictOf: () => 'passthrough' });
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'JEV_E_AUTH');
    assert.equal(out.meta.verdict_suggestion, 'passthrough');

    const tel = readJsonl(dir, 'telemetry.jsonl');
    assert.equal(tel[0].error, 'JEV_E_AUTH');
    assert.equal(tel[0].verdict, 'passthrough');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
