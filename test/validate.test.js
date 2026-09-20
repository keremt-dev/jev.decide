import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecideInput } from '../lib/validate.js';

const choiceQ = {
  type: 'choice',
  instructions: 'Bu dosya görevle ilgili mi?',
  criteria: { relevant: 'Görevle ilgili', other: 'Yukarıdakilerin hiçbiri' },
};
const scoreQ = {
  type: 'score',
  instructions: 'Şiddet nedir?',
  criteria: ['düşük', 'yüksek'],
};
const noulQ = { type: 'noul', instructions: 'Bu iddia doğru.' };

function okInput(extra = {}) {
  return { state: 'bağlam', questions: { q1: choiceQ }, ...extra };
}

test('geçerli girdiler: choice / score / noul / route / model / ttl', () => {
  const { warnings } = validateDecideInput({
    state: { files: ['a'] },
    questions: { q1: choiceQ, q2: scoreQ, q3: noulQ },
    route: 'test.triage',
    model: 'jev-1.13.0',
    ttl_seconds: 60,
  });
  assert.deepEqual(warnings, []);
});

test('eksik/geçersiz gövde → JEV_E_BAD_REQUEST', () => {
  assert.throws(() => validateDecideInput(null), { code: 'JEV_E_BAD_REQUEST' });
  assert.throws(() => validateDecideInput({}), { code: 'JEV_E_BAD_REQUEST' }); // state yok
  assert.throws(() => validateDecideInput({ state: 5, questions: { q: choiceQ } }), { code: 'JEV_E_BAD_REQUEST' });
  assert.throws(() => validateDecideInput({ state: 's', questions: [] }), { code: 'JEV_E_BAD_REQUEST' });
  assert.throws(() => validateDecideInput({ state: 's', questions: {} }), { code: 'JEV_E_BAD_REQUEST' });
});

test('choice kaçış seçeneği yoksa → JEV_E_NO_ESCAPE (yerel hata, HTTPye gitmez)', () => {
  const noEscape = { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } };
  assert.throws(
    () => validateDecideInput({ state: 's', questions: { q: noEscape } }),
    { code: 'JEV_E_NO_ESCAPE' },
  );
  const withNone = { ...noEscape, criteria: { a: 'A', none_of_the_above: 'hiçbiri' } };
  validateDecideInput({ state: 's', questions: { q: withNone } }); // geçerli
});

test('choice seçenek sayısı sınırları', () => {
  const mk = (n) => {
    const criteria = {};
    for (let i = 0; i < n; i++) criteria[`o${i}`] = 'r';
    criteria.other = 'x';
    return criteria;
  };
  // tek seçenek (kaçış dahil 1) → sayı hatası (count kontrolü escape kontrolünden önce)
  assert.throws(
    () => validateDecideInput({ state: 's', questions: { q: { type: 'choice', instructions: 'x', criteria: { a: 'A' } } } }),
    { code: 'JEV_E_BAD_REQUEST' },
  );
  validateDecideInput({ state: 's', questions: { q: { type: 'choice', instructions: 'x', criteria: mk(254) } } }); // 254+other = 255 → sınır
  assert.throws(
    () => validateDecideInput({ state: 's', questions: { q: { type: 'choice', instructions: 'x', criteria: mk(255) } } }), // 255+other = 256 → aşım
    { code: 'JEV_E_BAD_REQUEST' },
  );
});

test('score düzey sınırları ve noul criteria yasağı', () => {
  assert.throws(
    () => validateDecideInput({ state: 's', questions: { q: { type: 'score', instructions: 'x', criteria: ['a'] } } }),
    { code: 'JEV_E_BAD_REQUEST' },
  );
  assert.throws(
    () => validateDecideInput({ state: 's', questions: { q: { type: 'noul', instructions: 'x', criteria: ['a', 'b'] } } }),
    { code: 'JEV_E_BAD_REQUEST' },
  );
});

test('state > 32k token → JEV_E_STATE_TOO_LARGE', () => {
  const big = 'x'.repeat(200_000); // ~50k token tahmini
  assert.throws(() => validateDecideInput(okInput({ state: big })), { code: 'JEV_E_STATE_TOO_LARGE' });
});

test('aritmetik/tarih kalıbı → JEV_W_CODE_OP yumuşak uyarı', () => {
  const w1 = { type: 'noul', instructions: 'Log satırlarında kaç tane hata var?' };
  const { warnings } = validateDecideInput({ state: 's', questions: { q: w1 } });
  assert.equal(warnings[0]?.code, 'JEV_W_CODE_OP');

  const w2 = { type: 'noul', instructions: 'toplamı 100ü geçiyor' };
  assert.equal(validateDecideInput({ state: 's', questions: { q: w2 } }).warnings[0]?.code, 'JEV_W_CODE_OP');

  const w3 = { type: 'noul', instructions: 'hangi tarih önce' };
  assert.equal(validateDecideInput({ state: 's', questions: { q: w3 } }).warnings[0]?.code, 'JEV_W_CODE_OP');
});

test('bağımlı soru referansı → JEV_W_DEPENDENT uyarısı', () => {
  const a = { type: 'noul', instructions: 'Bu bir iddia.' };
  const b = { type: 'noul', instructions: 'q_a sorusunun yanıtına göre mi?' };
  const { warnings } = validateDecideInput({ state: 's', questions: { q_a: a, q_b: b } });
  assert.ok(warnings.some((w) => w.code === 'JEV_W_DEPENDENT'));
});

test('route/model/ttl doğrulaması', () => {
  assert.throws(() => validateDecideInput(okInput({ route: '' })), { code: 'JEV_E_BAD_REQUEST' });
  assert.throws(() => validateDecideInput(okInput({ route: 5 })), { code: 'JEV_E_BAD_REQUEST' });
  assert.throws(() => validateDecideInput(okInput({ model: 'gpt-9' })), { code: 'JEV_E_BAD_REQUEST' });
  assert.throws(() => validateDecideInput(okInput({ ttl_seconds: -1 })), { code: 'JEV_E_BAD_REQUEST' });
  assert.throws(() => validateDecideInput(okInput({ ttl_seconds: 90000 })), { code: 'JEV_E_BAD_REQUEST' });
  validateDecideInput(okInput({ ttl_seconds: 0 })); // 0 = cache yok, geçerli
});
