# `jev.decide` — MCP Tool Sözleşmesi

MCP server adı: `jev` · Tool adı: `decide` (ZCode'ta `mcp__jev__decide` olarak görünür)
Sürüm: 0.1 (tasarım) · Hedef API: `POST https://api.typesafe.ai/v1/systemone` (`typesafe/jev-1.13`)

## 1. Girdi şeması

```jsonc
{
  "type": "object",
  "required": ["state", "questions"],
  "properties": {
    "state": {
      // string | object | array — filtrelenmiş bağlam.
      // Kod / dosya / log / komut metni. Hedef: ≤ ~32k token.
      "description": "Karar verilecek bağlam. İlgisiz içerik accuracy'yi düşürür; göndermeden önce filtrele."
    },
    "questions": {
      "type": "object",
      "minProperties": 1,
      "description": "Atomik sorular. Tek HTTP çağrısında toplu gider (fan-out). Her soru tek bir yargı içerir.",
      "additionalProperties": {
        "oneOf": [
          { "$ref": "#/definitions/choiceQuestion" },
          { "$ref": "#/definitions/scoreQuestion" },
          { "$ref": "#/definitions/noulQuestion" }
        ]
      }
    },
    "route": {
      "type": "string",
      "description": "thresholds.yaml'daki route kimliği (ör. 'hook.risk_gate'). Eşik ve telemetri anahtarı olarak kullanılır. Opsiyonel: verilmezse 'adhoc' sayılır."
    },
    "model": {
      "type": "string",
      "enum": ["jev-latest", "jev-1.13.0", "jev-preview"],
      "description": "Öntanımlı jev-latest."
    },
    "ttl_seconds": {
      "type": "integer",
      "minimum": 0, "maximum": 86400,
      "description": "Bu çağrının içerik-hash cache'te tutulma süresi. 0 = cache yok. Route öntanımlısı geçersiz kılınır."
    }
  },

  "definitions": {
    "choiceQuestion": {
      "required": ["type", "instructions", "criteria"],
      "properties": {
        "type": { "const": "choice" },
        "instructions": { "type": "string" },
        "criteria": {
          "type": "object",
          "minProperties": 2, "maxProperties": 255,
          "description": "Seçenek etiketi → rubrik (o seçeneğin ne demesini istediğini tanımlar) | null.",
          "additionalProperties": { "type": ["string", "null"] }
        }
      },
      "allOf": [{
        "description": "choice paketinde bir kaçış seçeneği zorunludur (other/none/benzeri).",
        "anyOf": [
          { "properties": { "criteria": { "required": ["other"] } } },
          { "properties": { "criteria": { "required": ["none_of_the_above"] } } }
        ]
      }]
    },
    "scoreQuestion": {
      "required": ["type", "instructions", "criteria"],
      "properties": {
        "type": { "const": "score" },
        "instructions": { "type": "string" },
        "criteria": {
          "type": "array",
          "minItems": 2, "maxItems": 20,
          "items": { "type": "string" },
          "description": "Sıralı düzeyler, düşükten yükseğe (rubrik)."
        }
      }
    },
    "noulQuestion": {
      "required": ["type", "instructions"],
      "properties": {
        "type": { "const": "noul" },
        "instructions": { "type": "string", "description": "Tek bir iddia/evet-hayır yargısı." }
      }
    }
  }
}
```

### İstemci tarafı doğrulamalar (reddedilen girişler → yerel hata, HTTP'ye gitmez)

- `choice` paketinde kaçış seçeneği yok → `JEV_E_NO_ESCAPE`.
- `instructions` içinde aritmetik/tarih karşılaştırma beklentisi tespit edilirse (yumuşak uyarı,
  yalnızca bilinen kalıplar: "kaç tane", "toplamı", "hangi tarih önce") → `JEV_W_CODE_OP`.
- `state` tahmini token > 32k → `JEV_E_STATE_TOO_LARGE` (gönderen filtrelesin).
- Aynı `questions` içinde bağımlı sorular (birinin yanıtını diğerinin gerektirdiği bariz
  referanslar) → uyarı; bağımlı yargılar ayrı çağrılara bölünmeli.

## 2. Çıktı şeması

```jsonc
{
  "answers": {
    "<id>": {
      "value": "…",              // choice: seçilen etiket | score: seçilen düzey | noul: "yes"|"no"
      "probabilities": { … },    // choice/score: dağılım | noul: { "yes": p, "no": 1-p }
      "confidence": 0.0          // 0–1, kalibre | noul: yok → null
    }
  },
  "meta": {
    "model": "jev-1.13.0",       // sunucunun çözdüğü sürümlü kimlik
    "request_id": "…",           // x-typesafe-request-id — loglanır
    "latency_ms": 412,
    "cached": false,
    "usage": { "input_tokens": 1830, "output_tokens": 0 },
    "route": "hook.risk_gate",
    "mode": "active",            // route modu (off|shadow|active) — gölge sonuç aksiyona çevrilmez
    "floor": 0.6,                // route güven tabanı (yorum çağırıcının)
    "thresholds": { … },         // route eşikleri — agent sabit eşik taşımaz
    "warnings": [ … ]            // JEV_W_* yumuşak uyarıları (ör. aritmetik kalıbı)
  }
}
```

## 3. Hata semantiği

| Durum | Davranış | MCP'ye dönen |
|---|---|---|
| `422` | Asla retry — çağıran hatası | `JEV_E_BAD_REQUEST` + API mesajı |
| `429` / `529` | Retry: max 3, üstel backoff, `retry-after`e saygı — **toplam süre bütçesi** (`request_timeout_ms`, denemeler + backoff dahil) bağlayıcıdır; bütçe biterse beklemek yerine vazgeçilir | tükenirse `JEV_E_RATE_LIMIT` |
| `401/403` | Retry yok | `JEV_E_AUTH` (anahtar yok/geçersiz — fail-open çağıranına bırakılır) |
| `5xx` (diğer) / ağ / timeout | Retry yok (tasarım kararı: karar katmanı idempotent değilse gecikme katlanır; route isterse açıkça `retry: true`) | `JEV_E_UNAVAILABLE` |
| `200` ama yanıt eksik/bozuk | Retry yok — istenen her soru için value/probabilities/confidence şema denetimi yapılır; cache'e **yazılmaz** | `JEV_E_BAD_RESPONSE` |
| route `mode: off` | Çağrı yok, telemetri yok ("off (kayıt yok)") | `JEV_E_ROUTE_OFF` + passthrough önerisi |
| Mock modu `JEV_MOCK=1` | HTTP yerine deterministik sahte yanıt + enjekte edilebilir gecikme | — |

**Çağıran sözleşmesi:** bu hataların hiçbiri agent akışını durdurmaz; her çağıran route
eşiklerine göre `passthrough`/`escalate` türetir (fail-open). Hata yanıtlarında `meta.error`
alanı + `verdict: "passthrough"` önerisi taşınır.

## 4. Cache

- Anahtar: `sha256(model ∥ canonical_json(state) ∥ canonical_json(questions) ∥ kaynak_etiketi)`.
  Kaynak etiketi = `mock|canlı` + `baseUrl` — mock sonuçlar canlı modda (ve tersi) kullanılamaz.
- TTL: route öntanımlısı (`thresholds.yaml`) → çağrı bazlı `ttl_seconds` ile geçersiz kılınır.
- Hook route'u aynı içerik hash'ini kullanır; state komut+cwd+git_dirty içerdiğinden anahtar
  bağlam duyarlıdır (aynı komut farklı çalışma dizininde yeniden değerlendirilir).
- Cache isabeti telemetriye `cached: true` olarak yazılır (latency ölçümünü bulanmasın).
- Cache'e yalnız doğrulanmış yanıtlar yazılır (§3 `JEV_E_BAD_RESPONSE`).

## 5. Telemetri olay şeması (`.jev/telemetry.jsonl`, satır başına bir olay)

```jsonc
{
  "ts": "2026-09-19T09:41:03Z",
  "route": "hook.risk_gate",
  "question_ids": ["q_class", "q_conf"],
  "answers": { "q_class": { "value": "destructive", "confidence": 0.91 } },
  "verdict": "ask",              // passthrough | note | ask | act | confirm | escalate
  "outcome": "user_approved",     // sonra doldurulabilir (kalibrasyon)
  "request_id": "req_…", "latency_ms": 388, "cached": false,
  "mode": "shadow",               // off | shadow | active
  "model": "jev-1.13.0"
}
```

Kural: `state` ve soru metinleri telemetriye **asla** yazılmaz (yalnız kimlikleri).
PII taraması yükleyiciye değil, kayıt katmanına aittir.

## 6. Çevirici (adapter) notları

- **Gerçek API tel biçimi (doğrulandı 2026-09-20) ve normallik:** `/v1/systemone` yanıtı soru
  başına doğal alanlar döndürür — choice: `{choice: <etiket>, confidence, probabilities}`,
  noul: `{noul: <p>}` (confidence yok). `lib/client.js#normalizeAnswers` bunları §2'deki
  sözleşmeye çevirir (`value` / `probabilities` / `confidence`; noul → `value: yes|no`
  (p≥0.5) + `probabilities:{yes,no}`). MCP aracının çıktısı her zaman §2 biçimindedir.
- OpenAI/Anthropic uyumlu katmana **çevrilmez**: `messages[]` normalizasyonu
  `probabilities`/`confidence`'ı yok eder (imajin-ai bulgusu). Jev yalnızca kendi sözleşmesiyle sunulur.
- `GET /v1/models` açılışta bir kez çağrılır (anahtar doğrulama + sürüm yoklama; 401 → `JEV_E_AUTH`).
  Gerçek yanıt (2026-09-20): `{"models":[{"name":"jev-latest",...},{"name":"jev-preview",...}]}`.
- SDK kullanımı yerine sıfır bağımlılıklı `fetch` sarmalayıcı seçildi (Node ≥ 18 yerleşik); resmi
  SDK gerektiğinde `lib/client.js` tek dosyada değiştirilebilir.
