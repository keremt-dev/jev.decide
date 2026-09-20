import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPackage, withPrefix } from '../lib/questions.js';

const ROUTES = [
  'hook.risk_gate',
  'search.triage',
  'review.comment_filter',
  'test.triage',
  'verify.checklist',
];

test('tüm soru paketleri yüklenir ve choice paketlerinde kaçış seçeneği zorunlu', () => {
  for (const route of ROUTES) {
    const pkg = loadPackage(route);
    const ids = Object.keys(pkg);
    assert.ok(ids.length >= 1, `${route} boş olamaz`);
    for (const [id, q] of Object.entries(pkg)) {
      assert.ok(['choice', 'score', 'noul'].includes(q.type), `${route}.${id}.type`);
      assert.equal(typeof q.instructions, 'string');
      assert.ok(q.instructions.length > 0);
      if (q.type === 'choice') {
        assert.ok(
          'other' in q.criteria || 'none_of_the_above' in q.criteria,
          `${route}.${id}: choice paketinde kaçış seçeneği yok`,
        );
      }
    }
  }
});

test('hook.risk_gate paketi: q_class + q_conf, use-cases §4 ile birebir', () => {
  const pkg = loadPackage('hook.risk_gate');
  assert.deepEqual(Object.keys(pkg).sort(), ['q_class', 'q_conf']);
  assert.deepEqual(
    Object.keys(pkg.q_class.criteria).sort(),
    ['destructive', 'other', 'reversible', 'safe'],
  );
});

test('withPrefix: aday kimliği öneki ekler (fan-out)', () => {
  const pkg = withPrefix(loadPackage('search.triage'), 'f14_');
  assert.ok('f14_relevant' in pkg);
  assert.ok('f14_role' in pkg);
});
