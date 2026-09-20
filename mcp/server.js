#!/usr/bin/env node
// MCP server "jev" — tool: decide (docs/tool-schema.md).
// Sıfır bağımlılık: JSON-RPC 2.0 over stdio (newline-delimited), Node ≥ 18.17.
// ZCode / Claude Code / Codex — hepsi MCP stdio server'ı aynı şekilde bağlar.
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DecidePipeline } from '../lib/core.js';
import { JevClient } from '../lib/client.js';

const SERVER_NAME = 'jev';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

// docs/tool-schema.md §1'in birebir taşıması — şema tek kaynak olarak dursun.
const DECIDE_INPUT_SCHEMA = {
  type: 'object',
  required: ['state', 'questions'],
  properties: {
    state: {
      description:
        'Karar verilecek bağlam (string | object | array). Filtrelenmiş, görevle ilgili içerik; hedef ≤ ~32k token. İlgisiz içerik accuracy düşürür.',
    },
    questions: {
      type: 'object',
      minProperties: 1,
      description: 'Atomik sorular (id → soru). Tek HTTP çağrısında toplu gider (fan-out). Her soru tek bir yargı içerir.',
      additionalProperties: {
        oneOf: [
          { $ref: '#/definitions/choiceQuestion' },
          { $ref: '#/definitions/scoreQuestion' },
          { $ref: '#/definitions/noulQuestion' },
        ],
      },
    },
    route: {
      type: 'string',
      description:
        "thresholds.yaml'daki route kimliği (ör. 'hook.risk_gate', 'test.triage'). Eşik/telemetri anahtarıdır. Verilmezse 'adhoc' sayılır.",
    },
    model: {
      type: 'string',
      enum: ['jev-latest', 'jev-1.13.0', 'jev-preview'],
      description: 'Öntanımlı jev-latest.',
    },
    ttl_seconds: {
      type: 'integer',
      minimum: 0,
      maximum: 86400,
      description: 'Bu çağrının içerik-hash cache süresi (saniye). 0 = cache yok. Route öntanımlısını geçersiz kılar.',
    },
  },
  definitions: {
    choiceQuestion: {
      type: 'object',
      required: ['type', 'instructions', 'criteria'],
      properties: {
        type: { const: 'choice' },
        instructions: { type: 'string', description: 'Kelimenin tam anlamıyla alınan talimat; örtük koşul içermemeli.' },
        criteria: {
          type: 'object',
          minProperties: 2,
          maxProperties: 255,
          additionalProperties: { type: ['string', 'null'] },
          description: 'Seçenek etiketi → rubrik (string) | null. Bir kaçış seçeneği (other / none_of_the_above) ZORUNLU.',
        },
      },
    },
    scoreQuestion: {
      type: 'object',
      required: ['type', 'instructions', 'criteria'],
      properties: {
        type: { const: 'score' },
        instructions: { type: 'string' },
        criteria: {
          type: 'array',
          minItems: 2,
          maxItems: 20,
          items: { type: 'string' },
          description: 'Sıralı düzeyler, düşükten yükseğe (rubrik).',
        },
      },
    },
    noulQuestion: {
      type: 'object',
      required: ['type', 'instructions'],
      properties: {
        type: { const: 'noul' },
        instructions: { type: 'string', description: 'Tek bir iddia / evet-hayır yargısı.' },
      },
    },
  },
};

const DECIDE_TOOL = {
  name: 'decide',
  description:
    'Jev (TypeSafe.ai System One) tipli karar katmanı: choice/score/noul sorularını tek çağrıda, olasılık + kalibre güven ile yanıtlar. ' +
    'Filtrele/sırala/sınıflandır/eşikle türünden ara kararlar için. Aritmetik, tarih, sayma ve metin üretimi için KULLANMA. ' +
    'Hata durumunda fail-open: error.verdict_suggestion=passthrough döner, akışı durdurmaz.',
  inputSchema: DECIDE_INPUT_SCHEMA,
};

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// Test edilebilir mesaj işleyici — stdio döngüsünden bağımsız.
export function createMessageHandler({ pipeline = null, loadError = null } = {}) {
  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return null;
    const isRequest = msg.id !== undefined;

    if (msg.method === 'initialize') {
      return result(msg.id, {
        protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return null;
    if (msg.method === 'ping') return isRequest ? result(msg.id, {}) : null;

    if (msg.method === 'tools/list') {
      return result(msg.id, { tools: [DECIDE_TOOL] });
    }

    if (msg.method === 'tools/call') {
      if (!isRequest) return null;
      const { name, arguments: args = {} } = msg.params || {};
      if (name !== 'decide') {
        return rpcError(msg.id, -32602, `Bilinmeyen tool: ${name}`);
      }
      if (!pipeline) {
        return result(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'JEV_E_CONFIG', message: `Sunucu yapılandırması yüklenemedi: ${loadError?.message || 'thresholds.yaml okunamadı'}` }, meta: { verdict_suggestion: 'passthrough' } }) }],
          isError: true,
        });
      }
      const out = await pipeline.run(args);
      return result(msg.id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        isError: !out.ok,
      });
    }

    if (isRequest) return rpcError(msg.id, -32601, `Method yok: ${msg.method}`);
    return null;
  };
}

export async function main() {
  let pipeline = null;
  let loadError = null;
  try {
    pipeline = DecidePipeline.load();
  } catch (e) {
    loadError = e;
  }

  // Açılış yoklaması (schema §6): anahtar doğrulama + sürüm yoklama — arka planda, akışı bloklamaz.
  const client = pipeline?.client || new JevClient();
  if (!client.mockMode) {
    client
      .probeModels()
      .then((r) => process.stderr.write(`[jev] /v1/models ok: ${(r.models || []).join(', ') || '(liste boş)'}\n`))
      .catch((e) => process.stderr.write(`[jev] /v1/models başarısız (${e.code || 'ERR'}): ${e.message}\n`));
  } else {
    process.stderr.write('[jev] JEV_MOCK=1 — mock modda çalışıyor\n');
  }

  const handle = createMessageHandler({ pipeline, loadError });
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue; // bozuk satır — istek kimliği olmadan yanıtlanamaz
    }
    let response;
    try {
      response = await handle(msg);
    } catch (e) {
      response = msg.id !== undefined ? rpcError(msg.id, -32603, `İç sunucu hatası: ${e?.message || e}`) : null;
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`[jev] ölümcül: ${e?.stack || e}\n`);
    process.exit(1);
  });
}
