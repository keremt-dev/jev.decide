import test from 'node:test';
import assert from 'node:assert/strict';
import { JevClient } from '../lib/client.js';

const qs = {
  q_class: {
    type: 'choice',
    instructions: 'Sınıf nedir?',
    criteria: { safe: 'ok', destructive: 'tehlike', other: 'hiçbiri' },
  },
  q_conf: { type: 'noul', instructions: 'Onay istenmeli.' },
};

// Test yanıtları: client yalnızca res.ok/status/text()/headers.get kullanır.
const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

function httpCalls() {
  const calls = [];
  const fetchImpl = (url, opts) => {
    calls.push({ url, opts });
    return fetchImpl.responses.shift();
  };
  fetchImpl.responses = [];
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('mock: deterministik — aynı girdi aynı yanıtı üretir', async () => {
  const c = new JevClient({ config: { mock: true } });
  const r1 = await c.decide({ state: 's1', questions: qs });
  const r2 = await c.decide({ state: 's1', questions: qs });
  assert.deepEqual(r1.answers, r2.answers);
  assert.equal(r1.meta.request_id, r2.meta.request_id);
  assert.equal(r1.meta.model, 'jev-mock-1.0');
  assert.equal(r1.meta.mock, true);
  assert.ok(r1.meta.request_id.startsWith('mock_'));
});

test('mock: yanıt biçimi şemaya uygun (value/probabilities/confidence; noul confidence null)', async () => {
  const c = new JevClient({ config: { mock: true } });
  const r = await c.decide({ state: 's', questions: qs });
  const cls = r.answers.q_class;
  assert.ok(['safe', 'destructive', 'other'].includes(cls.value));
  assert.equal(cls.probabilities[cls.value] > 0.5, true);
  assert.ok(cls.confidence >= 0.55 && cls.confidence <= 0.97);
  const noul = r.answers.q_conf;
  assert.ok(['yes', 'no'].includes(noul.value));
  assert.equal(noul.confidence, null);
  assert.ok(noul.probabilities.yes + noul.probabilities.no > 0.99);
});

test('mock: JEV_MOCK_FORCE soru bazlı geçersiz kılar (shadow testleri için)', async () => {
  const c = new JevClient({
    config: {
      mock: true,
      mockForce: { q_class: { value: 'destructive', confidence: 0.93 } },
    },
  });
  const r = await c.decide({ state: 's', questions: qs });
  assert.equal(r.answers.q_class.value, 'destructive');
  assert.equal(r.answers.q_class.confidence, 0.93);
});

test('mock: JEV_MOCK_DELAY_MS gecikme enjeksiyonu', async () => {
  const c = new JevClient({ config: { mock: true, mockDelayMs: 80 }, sleep: async () => {} });
  let slept = 0;
  c.sleep = async (ms) => {
    slept += ms;
  };
  await c.decide({ state: 's', questions: qs });
  assert.equal(slept, 80);
});

test('anahtar yoksa (mock kapalı) → JEV_E_AUTH, HTTPye gitmez', async () => {
  const fetchImpl = httpCalls();
  const c = new JevClient({ config: { apiKey: null }, fetchImpl });
  await assert.rejects(() => c.decide({ state: 's', questions: qs }), {
    code: 'JEV_E_AUTH',
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test('422 → JEV_E_BAD_REQUEST, retry yok', async () => {
  const fetchImpl = httpCalls();
  fetchImpl.responses = [res(422, { error: { message: 'criteria eksik' } })];
  const c = new JevClient({ config: { apiKey: 'k' }, fetchImpl, sleep: async () => {} });
  await assert.rejects(() => c.decide({ state: 's', questions: qs }), (e) => {
    assert.equal(e.code, 'JEV_E_BAD_REQUEST');
    assert.match(e.message, /criteria eksik/);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('401 → JEV_E_AUTH, retry yok', async () => {
  const fetchImpl = httpCalls();
  fetchImpl.responses = [res(401, { error: 'unauthorized' })];
  const c = new JevClient({ config: { apiKey: 'kotu' }, fetchImpl, sleep: async () => {} });
  await assert.rejects(() => c.decide({ state: 's', questions: qs }), { code: 'JEV_E_AUTH' });
  assert.equal(fetchImpl.calls.length, 1);
});

const OK_BODY = {
  answers: { q_class: { type: 'choice', choice: 'safe', confidence: 0.9, probabilities: { safe: 0.9 } }, q_conf: { type: 'noul', noul: 0.6 } },
  model: 'jev-1.13.0',
};

test('429 sonra 200 → retry eder (max 3, backoff uygulanır), sonra başarı', async () => {
  const fetchImpl = httpCalls();
  fetchImpl.responses = [
    res(429, {}, { 'retry-after': '0' }),
    res(529, {}),
    res(200, OK_BODY, { 'x-typesafe-request-id': 'req_1' }),
  ];
  const sleeps = [];
  const c = new JevClient({
    config: { apiKey: 'k' },
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms),
  });
  const r = await c.decide({ state: 's', questions: qs }, { maxRetries: 3 });
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(sleeps, [400, 800]); // retry-after 0ms + üstel 400·2^n (bütçe içinde)
  assert.equal(r.meta.request_id, 'req_1');
  assert.equal(r.meta.model, 'jev-1.13.0');
  assert.ok(r.meta.latency_ms >= 0);
  // normaller + doğrulama: her soru geçerli yanıt aldı
  assert.equal(r.answers.q_class.value, 'safe');
  assert.equal(r.answers.q_conf.value, 'yes');
});

test('B08: retry beklemesi TOPLAM bütçeye bağlı — 429+Retry-After:60 hızla tükensin', async () => {
  const fetchImpl = httpCalls();
  fetchImpl.responses = Array(10).fill(res(429, {}, { 'retry-after': '60' }));
  const sleeps = [];
  let t = 1000; // sanal saat: sleep gerçek beklemek yerine saati ilerletir
  const c = new JevClient({
    config: { apiKey: 'k' },
    fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  await assert.rejects(() => c.decide({ state: 's', questions: qs }, { timeoutMs: 5000 }), {
    code: 'JEV_E_RATE_LIMIT',
  });
  assert.equal(fetchImpl.calls.length, 1); // ikinci deneme yok: bütçe beklemeye gitti
  assert.deepEqual(sleeps, [5000]); // 60s talebi 5s bütçeye kırpıldı
});

test('429 tükenirse → JEV_E_RATE_LIMIT (3 retry sonrası)', async () => {
  const fetchImpl = httpCalls();
  fetchImpl.responses = Array(10).fill(res(429, {}));
  const sleeps = [];
  const c = new JevClient({
    config: { apiKey: 'k' },
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms),
  });
  await assert.rejects(() => c.decide({ state: 's', questions: qs }), { code: 'JEV_E_RATE_LIMIT' });
  assert.equal(fetchImpl.calls.length, 4); // 1 + 3 retry
  assert.equal(sleeps.length, 3);
});

test('diğer 5xx → JEV_E_UNAVAILABLE, retry YOK (tasarım kararı)', async () => {
  const fetchImpl = httpCalls();
  fetchImpl.responses = [res(503, { error: 'down' })];
  const c = new JevClient({ config: { apiKey: 'k' }, fetchImpl, sleep: async () => {} });
  await assert.rejects(() => c.decide({ state: 's', questions: qs }), { code: 'JEV_E_UNAVAILABLE' });
  assert.equal(fetchImpl.calls.length, 1);
});

test('timeout (abort) → JEV_E_UNAVAILABLE', async () => {
  const fetchImpl = (url, opts) =>
    new Promise((_, rej) => {
      opts.signal.addEventListener('abort', () => rej(new Error('This operation was aborted')));
    });
  const c = new JevClient({ config: { apiKey: 'k' }, fetchImpl });
  await assert.rejects(() => c.decide({ state: 's', questions: qs }, { timeoutMs: 50 }), {
    code: 'JEV_E_UNAVAILABLE',
  });
});

test('gerçek API doğal biçimi normallenir: choice→value, noul→yes/no + probabilities', async () => {
  const { normalizeAnswers } = await import('../lib/client.js');
  const norm = normalizeAnswers({
    q_class: { type: 'choice', choice: 'destructive', confidence: 0.9, probabilities: { destructive: 0.93, safe: 0 } },
    q_score: { type: 'score', score: 'düzeltilmeli', confidence: 0.8 },
    q_conf: { type: 'noul', noul: 0.75 },
    q_low: { type: 'noul', noul: 0.2 },
  });
  assert.equal(norm.q_class.value, 'destructive');
  assert.equal(norm.q_class.confidence, 0.9);
  assert.equal(norm.q_class.probabilities.destructive, 0.93);
  assert.equal(norm.q_score.value, 'düzeltilmeli');
  assert.equal(norm.q_conf.value, 'yes');
  assert.deepEqual(norm.q_conf.probabilities, { yes: 0.75, no: 0.25 });
  assert.equal(norm.q_conf.confidence, null);
  assert.equal(norm.q_low.value, 'no');
  assert.equal(norm.q_low.probabilities.yes, 0.2);
});

test('B07: HTTP 200 ama yanıt boş/eksik → JEV_E_BAD_RESPONSE, retry yok, cache yazılmaz', async () => {
  const cases = [
    res(200, {}), // answers hiç yok
    res(200, { answers: { q_class: OK_BODY.answers.q_class } }), // q_conf eksik
    res(200, { answers: { q_class: { type: 'choice', choice: 'tanımsız', confidence: 0.9 }, q_conf: { type: 'noul', noul: 0.6 } } }), // seçenek dışı değer
    res(200, { answers: { q_class: { type: 'choice', choice: 'safe', confidence: 1.7 }, q_conf: { type: 'noul', noul: 0.6 } } }), // confidence aralık dışı
  ];
  for (const bad of cases) {
    const fetchImpl = httpCalls();
    fetchImpl.responses = [bad];
    const c = new JevClient({ config: { apiKey: 'k' }, fetchImpl, sleep: async () => {} });
    await assert.rejects(() => c.decide({ state: 's', questions: qs }), { code: 'JEV_E_BAD_RESPONSE' });
    assert.equal(fetchImpl.calls.length, 1);
  }
});

test('B09: noul sınıflama ham olasılıktan — 0.4999 no, 0.5 yes, 0.5001 yes', async () => {
  const { normalizeAnswers } = await import('../lib/client.js');
  const n = (p) => normalizeAnswers({ q: { type: 'noul', noul: p } }).q;
  assert.equal(n(0.4999).value, 'no');
  assert.equal(n(0.4999).probabilities.yes, 0.5); // gösterim yuvarlaması kararı değiştirmez
  assert.equal(n(0.5).value, 'yes');
  assert.equal(n(0.5001).value, 'yes');
  assert.equal(n(0.5001).probabilities.yes, 0.5);
});

test('probeModels: {models:[{name}]} tel biçimi çözülür + timeout üst sınırı (küçük 2)', async () => {
  const fetchImpl = (url, opts) => {
    assert.ok(opts.signal, 'yoklamada abort sinyali olmalı');
    return Promise.resolve(res(200, { models: [{ name: 'jev-latest' }, { name: 'jev-preview' }] }));
  };
  const c = new JevClient({ config: { apiKey: 'k' }, fetchImpl });
  const r = await c.probeModels({ timeoutMs: 500 });
  assert.deepEqual(r.models, ['jev-latest', 'jev-preview']);
});

test('istek gövdesi ve üstbilgiler: POST /v1/systemone, Bearer, model koşullu', async () => {
  const fetchImpl = httpCalls();
  fetchImpl.responses = [res(200, OK_BODY)];
  const c = new JevClient({ config: { apiKey: 'k', baseUrl: 'https://api.typesafe.ai/' }, fetchImpl });
  await c.decide({ state: 's', questions: qs, model: 'jev-preview' });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers.authorization, 'Bearer k');
  const body = JSON.parse(call.opts.body);
  assert.equal(body.model, 'jev-preview');
  assert.deepEqual(body.questions, qs);
});
