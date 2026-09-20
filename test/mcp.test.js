import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMessageHandler } from '../mcp/server.js';
import { DecidePipeline } from '../lib/core.js';
import { JevClient } from '../lib/client.js';
import { loadThresholds } from '../lib/thresholds.js';

function mockHandler() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-mcp-'));
  const prev = process.env.JEV_STATE_DIR;
  process.env.JEV_STATE_DIR = dir;
  const pipeline = new DecidePipeline({
    thresholds: loadThresholds(),
    client: new JevClient({ config: { mock: true } }),
  });
  if (prev === undefined) delete process.env.JEV_STATE_DIR;
  else process.env.JEV_STATE_DIR = prev;
  return { handler: createMessageHandler({ pipeline }), dir };
}

const validArgs = {
  state: 'komut: rm -rf /tmp/x',
  route: 'adhoc',
  questions: {
    q_class: {
      type: 'choice',
      instructions: 'Bu komut hangi etkiyi yaratır?',
      criteria: { safe: 'ok', destructive: 'tehlike', other: 'hiçbiri' },
    },
  },
};

test('initialize: protocolVersion yankılanır, tools capability verilir', async () => {
  const { handler, dir } = mockHandler();
  try {
    const r = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(r.id, 1);
    assert.equal(r.result.protocolVersion, '2025-03-26');
    assert.deepEqual(r.result.capabilities, { tools: {} });
    assert.equal(r.result.serverInfo.name, 'jev');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bildirimler yanıtlanmaz (initialized), ping boş sonuç', async () => {
  const { handler, dir } = mockHandler();
  try {
    assert.equal(await handler({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const pong = await handler({ jsonrpc: '2.0', id: 7, method: 'ping' });
    assert.deepEqual(pong.result, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/list: decide aracı şemayla listelenir', async () => {
  const { handler, dir } = mockHandler();
  try {
    const r = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tool = r.result.tools[0];
    assert.equal(tool.name, 'decide');
    assert.equal(tool.inputSchema.required[0], 'state');
    assert.ok(tool.inputSchema.definitions.choiceQuestion);
    assert.deepEqual(tool.inputSchema.properties.model.enum, ['jev-latest', 'jev-1.13.0', 'jev-preview']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/call decide: mock başarı → isError false, içerik JSON', async () => {
  const { handler, dir } = mockHandler();
  try {
    const r = await handler({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'decide', arguments: validArgs } });
    assert.equal(r.result.isError, false);
    const payload = JSON.parse(r.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.meta.route, 'adhoc');
    assert.ok(payload.answers.q_class.value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/call decide: doğrulama hatası → isError true + JEV_E_NO_ESCAPE (fail-open zarfı)', async () => {
  const { handler, dir } = mockHandler();
  try {
    const bad = { ...validArgs, questions: { q: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } } } };
    const r = await handler({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'decide', arguments: bad } });
    assert.equal(r.result.isError, true);
    const payload = JSON.parse(r.result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'JEV_E_NO_ESCAPE');
    assert.equal(payload.meta.verdict_suggestion, 'passthrough');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/call bilinmeyen araç → JSON-RPC -32602; bilinmeyen method → -32601', async () => {
  const { handler, dir } = mockHandler();
  try {
    const r1 = await handler({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'yok', arguments: {} } });
    assert.equal(r1.error.code, -32602);
    const r2 = await handler({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
    assert.equal(r2.error.code, -32601);
    assert.equal(await handler({ jsonrpc: '2.0', method: 'notifications/abc' }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pipeline yüklenemediyse tools/call JEV_E_CONFIG zarfı döner (sunucu yine de ayağa kalkar)', async () => {
  const handler = createMessageHandler({ pipeline: null, loadError: new Error('yaml bozuk') });
  const r = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'decide', arguments: validArgs } });
  assert.equal(r.result.isError, true);
  const payload = JSON.parse(r.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'JEV_E_CONFIG');
  assert.equal(payload.meta.verdict_suggestion, 'passthrough');
});
