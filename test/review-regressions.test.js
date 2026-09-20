import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JevClient, normalizeAnswers } from '../lib/client.js';
import { DecidePipeline } from '../lib/core.js';
import { Cache, contentKey } from '../lib/cache.js';
import { loadThresholds } from '../lib/thresholds.js';
import { PassThrough } from 'node:stream';
import { serveStdio } from '../mcp/server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const questions = { q: { type: 'choice', instructions: 'Class?', criteria: { safe: null, other: null } } };
const temp = () => mkdtempSync(join(tmpdir(), 'jev-review-test-'));
function cleanup(dir) {
  assert.equal(resolve(dir).startsWith(resolve(tmpdir()) + '\\jev-review-test-') ||
    resolve(dir).startsWith(resolve(tmpdir()) + '/jev-review-test-'), true);
  rmSync(dir, { recursive: true, force: true });
}
function hook(dir, command, value = 'destructive') {
  const path = join(dir, 'thresholds.yaml');
  writeFileSync(path, readFileSync(join(root, 'docs/thresholds.yaml'), 'utf8').replace('mode: shadow', 'mode: active'));
  return spawnSync(process.execPath, [join(root, 'hooks/risk-gate.js')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir }),
    cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true,
    env: { ...process.env, JEV_STATE_DIR: dir, JEV_THRESHOLDS: path, JEV_MOCK: '1', JEV_MOCK_DELAY_MS: '0',
      JEV_MOCK_FORCE: JSON.stringify({ q_class: { value, confidence: 0.99 }, q_conf: { value: 'no' } }) },
  });
}

for (const command of ["git diff '--output'=valuable.txt", "git diff --out'put'=valuable.txt", 'git diff --ext-diff', 'git diff --output=x']) {
  test(`R01: evaluate non-allowlisted diff: ${command}`, () => {
    const dir = temp();
    try {
      const r = hook(dir, command);
      assert.equal(r.status, 0);
      assert.notEqual(r.stdout.trim(), '', 'must reach Jev');
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
    } finally { cleanup(dir); }
  });
}

test('R05: preserve quoted spaces in model state and shared cache', () => {
  const dir = temp();
  try {
    assert.equal(hook(dir, "rm -- 'important  data'", 'safe').stdout.trim(), '');
    const r = hook(dir, "rm -- 'important data'");
    assert.notEqual(r.stdout.trim(), '', 'different target must not hit the safe cache');
    const events = readFileSync(join(dir, 'telemetry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).cached, false);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
  } finally { cleanup(dir); }
});

for (const raw of [{ choice: 'toString', confidence: 0.9 }, { choice: 'safe', confidence: 'invalid' }, { noul: 1.0001 }, { noul: -0.0001 }]) {
  test(`R02: reject malformed raw answer without caching: ${JSON.stringify(raw)}`, async () => {
    let calls = 0;
    const client = new JevClient({ config: { mock: false, apiKey: 'test' }, fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ answers: { q: raw } }), { status: 200 });
    } });
    const pipeline = new DecidePipeline({ thresholds: loadThresholds(), client, cache: new Cache(),
      telemetry: { logDecision() {}, recordCalibration() {} } });
    const input = { state: 's', questions: 'noul' in raw ? { q: { type: 'noul', instructions: 'True?' } } : questions };
    for (let i = 0; i < 2; i++) {
      const result = await pipeline.run(input);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'JEV_E_BAD_RESPONSE');
    }
    assert.equal(calls, 2);
  });
}

test('R04: probe deadline includes response body consumption', async () => {
  let aborted = false;
  const client = new JevClient({ config: { mock: false, apiKey: 'test' }, fetchImpl: async (_url, { signal }) => ({
    ok: true, status: 200,
    json: () => new Promise((resolveBody, reject) => {
      const timer = setTimeout(() => resolveBody({ models: [{ name: 'late' }] }), 150);
      signal.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    }),
  }) });
  await assert.rejects(client.probeModels({ timeoutMs: 25 }), { code: 'JEV_E_UNAVAILABLE' });
  assert.equal(aborted, true);
});

test('noul preserves machine-consumed probability at threshold boundaries', () => {
  assert.equal(normalizeAnswers({ q: { noul: 0.8499 } }).q.probabilities.yes, 0.8499);
});

test('R03: real stdio serves ping before slow work and cancels without caching', { timeout: 6000 }, async () => {
  const dir = temp();
  const child = spawn(process.execPath, [join(root, 'mcp/server.js')], {
    cwd: dir, windowsHide: true,
    env: { ...process.env, JEV_STATE_DIR: dir, JEV_THRESHOLDS: join(root, 'docs/thresholds.yaml'),
      JEV_MOCK: '1', JEV_MOCK_FORCE: '', JEV_MOCK_DELAY_MS: '700' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let buffer = '';
  let resolvePing;
  const ping = new Promise(r => { resolvePing = r; });
  child.stdout.on('data', c => {
    buffer += c;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      messages.push(msg);
      if (msg.id === 2) resolvePing();
    }
  });
  const exited = new Promise(r => child.on('exit', r));
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'decide', arguments: { state: 's', questions } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    await ping;
    assert.equal(messages[0].id, 2, 'ping must overtake slow work');
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) + '\n');
    assert.equal(await exited, 0);
    assert.equal(messages.some(m => m.id === 1), false, 'cancelled request must not respond');
    assert.throws(() => readFileSync(join(dir, 'cache.json')), { code: 'ENOENT' });
  } finally {
    child.kill(); await exited; cleanup(dir);
  }
});

test('old cache namespace cannot retain pre-validation answers', async () => {
  const cache = new Cache();
  cache.set(contentKey({ model: 'jev-latest', state: 's', questions,
    extra: 'src:live|base:https://api.typesafe.ai' }), { answers: { q: { value: 'toString' } }, meta: {} }, 3600);
  let calls = 0;
  const client = new JevClient({ config: { mock: false, apiKey: 'test', baseUrl: 'https://api.typesafe.ai' },
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ answers: { q: { choice: 'safe', confidence: 0.9 } } })); } });
  const p = new DecidePipeline({ thresholds: loadThresholds(), cache, client,
    telemetry: { logDecision() {}, recordCalibration() {} } });
  const out = await p.run({ state: 's', questions });
  assert.equal(out.answers.q.value, 'safe');
  assert.equal(calls, 1);
});

for (const phase of ['fetch', 'backoff']) {
  test(`R03: abort reaches live client ${phase}`, async () => {
    const controller = new AbortController();
    let entered;
    const ready = new Promise(r => { entered = r; });
    let calls = 0;
    const client = new JevClient({ config: { mock: false, apiKey: 'test' }, fetchImpl: async (_url, { signal }) => {
      calls++;
      if (phase === 'backoff') return new Response('{}', { status: 429 });
      entered();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
    if (phase === 'backoff') {
      const realSleep = client.sleep;
      client.sleep = (ms, signal) => { entered(); return realSleep(ms, signal); };
    }
    const result = client.decide({ state: 's', questions }, { signal: controller.signal });
    await ready;
    controller.abort();
    await assert.rejects(result, { code: 'JEV_E_CANCELLED' });
    assert.equal(calls, 1);
  });
}

test('R03: concurrency and queue are bounded; queued cancellation never starts', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const started = [];
  const releases = new Map();
  const responses = [];
  let onPing;
  const ping = new Promise(r => { onPing = r; });
  output.on('data', line => { const msg = JSON.parse(line); responses.push(msg); if (msg.id === 99) onPing(); });
  const pipeline = { run: (args, { signal }) => new Promise((resolveRun, reject) => {
    started.push(args.n);
    releases.set(args.n, () => resolveRun({ ok: true, answers: {}, meta: {} }));
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) };
  const done = serveStdio({ input, output, pipeline, maxConcurrent: 2, maxQueued: 1 });
  for (const n of [1, 2, 3, 4]) input.write(JSON.stringify({ id: n, method: 'tools/call', params: { name: 'decide', arguments: { n } } }) + '\n');
  input.write(JSON.stringify({ id: 99, method: 'ping' }) + '\n');
  await ping;
  assert.deepEqual(started, [1, 2]);
  assert.equal(responses.find(r => r.id === 4).error.code, -32000);
  for (const requestId of [3, 1]) input.write(JSON.stringify({ method: 'notifications/cancelled', params: { requestId } }) + '\n');
  releases.get(2)();
  input.end();
  await done;
  assert.deepEqual(started, [1, 2]);
  assert.equal(responses.some(r => r.id === 1 || r.id === 3), false);
});
