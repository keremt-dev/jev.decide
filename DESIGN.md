# jev.decide — Mimari Tasarım

Sürüm: 0.2.2 (doğrulama bulgularının kapatılması) · Tarih: 2026-09-20
Girdiler: docs.typesafe.ai, resmi skill reposu, topluluk entegrasyonları (bkz. README §Kaynaklar)
Değişiklik 0.2: çoklu-harness kararı (ZCode + Claude Code + Codex), anahtar `JEV_API`,
§9 açık kararları kapatıldı, implementasyon haritası eklendi (§10).
Değişiklik 0.2.1: repo incelemesi bulguları B01–B09 + 4 küçük nokta düzeltildi
([docs/reviews/repo_inceleme_2026-09-20_v0.1.md](docs/reviews/repo_inceleme_2026-09-20_v0.1.md)):
hook sözleşme değeri `ask` (küçük harf), ham komut zincirleme denetimi, `git diff --output`
hariç tutma, kaynak (mock/canlı+baseUrl) etiketli ve bağlam (cwd/git_dirty) duyarlı cache
anahtarı, pipeline `off` modu + `meta.mode` + uyarıların meta'ya akışı, HTTP 200 yanıt
doğrulaması (`JEV_E_BAD_RESPONSE`), retry toplam süre bütçesi, noul ham olasılıkla sınıflama,
probeModels `name` alanı + timeout, yaml-mini tüketilmemiş içerik denetimi.

Değişiklik 0.2.2: yeniden doğrulamadaki R01–R05 kapatıldı. Git diff statik yolu basit
salt-okunur biçimlerle sınırlandı; komut metni model/cache için aynen korunuyor.
Ham confidence/noul doğrulaması ve own-key choice üyeliği eklendi; probability hassasiyeti
korunuyor. Cache `schema:2` ile önceki sonuçlardan ayrıldı. Model yoklamasının gövdesi
timeout kapsamına alındı. MCP en fazla 4 eşzamanlı karar ve 64 bekleyen istekle çalışır;
ping kuyruğu beklemez, iptal sinyali HTTP/mock/retry beklemesine taşınır ve iptal edilmiş
sonuç cache'e yazılmaz. Ayrıntılar: `docs/tool-schema.md`.

---

## 1. Amaç ve amaç-dışı

**Amaç:** ZCode'ta tekrarlayan, atomik, tipli kararları (filtreleme, sıralama, sınıflandırma,
doğrulama) Jev'e devretmek; kalibre güven ile `act / confirm / escalate` davranışı üretmek.

**Amaç-dışı (non-goals):**
- Jev'i model/beyin katmanına sokmak. Model seçici, planlama, kod üretimi, özetleme LLM'de kalır.
  (imajin-ai'nin "service connector, inference connector değil" ayrımı birebir benimsenir.)
- Jev ile metin üretimi, aritmetik, tarih karşılaştırma, sayma.
- ZCode izin sisteminin yerine geçmek. Hook yalnızca **yükseltici** (escalate-only) çalışır:
  ek onay isteyebilir, asla mevcut onayı sessizce geçiştiremez (bkz. §5.3).

## 2. Bileşen görünümü

```
ZCode agent döngüsü
│
├─ SKILL.md (kural katmanı) ──> ne zaman jev.decide çağırılır, nasıl yorumlanır
│
├─ MCP server "jev"
│    tool: decide(state, questions, opts)
│      ├─ soru doğrulama (şema + disiplin kuralları)
│      ├─ içerik-hash cache (TTL'li)
│      ├─ HTTP: POST api.typesafe.ai/v1/systemone
│      │    retry: yalnız 429/529, max 3, retry-after'e saygı | 422: asla retry
│      │    timeout: route bazlı (öntanımlı 5000ms)
│      └─ telemetri: .jev/telemetry.jsonl (+ kalibrasyon örnekleme)
│
├─ PreToolUse hook (risk kapısı, Bash matcher)
│    off → shadow → active; kararı yalnızca escalate yönünde uygular
│
└─ threshold motoru: thresholds.yaml okunur, karar kodu sabit içermez
```

**Paketleme (harness-bağımsız çekirdek):** karar (2026-09-20) — bileşenler tek bir harness'e
değil, üçüne (ZCode, Claude Code, Codex) bağlanır. Çekirdek ortaktır (MCP stdio hepsinde
desteklenir); yalnızca kayıt/adapter katmanı harness'e göre değişir.
```
jev.decide/
  lib/            → çekirdek: client, cache, thresholds, validate, telemetry, core (Node, sıfır bağımlılık)
  mcp/server.js   → MCP stdio server "jev" (ZCode / Claude Code / Codex aynı şekilde bağlar)
  hooks/          → PreToolUse risk kapısı (Claude Code + ZCode sözleşmesi; Codex hook desteklemez → fail-open)
  skills/jev-decide/SKILL.md → kural katmanı (Claude Code/ZCode skill; Codex'te AGENTS.md referansı)
  questions/      → soru paketleri (YAML)
  docs/…          → bu tasarım + thresholds.yaml + install.md
```
Claude Code plugin biçimi (`.claude-plugin/plugin.json`) ileriki aşama olarak açık kalır.
Not: resmi `typesafe-ai/skills` Claude Code/Codex içindir; buradaki SKILL.md onun
ZCode mekanizmalarına (MCP tool adları, hook noktaları) uyarlanmış türevidir — sıfırdan
değil, referans alarak.

## 3. `decide` çağrı sözleşmesi (özet)

Tam şema: [docs/tool-schema.md](docs/tool-schema.md). Özet:

```
jev.decide({
  state: string | object | array,        // filtrelenmiş bağlam (≤ ~32k tok hedef)
  questions: {                            // 1..N atomik soru — tek HTTP çağrısı
    <id>: { type: "choice" | "score" | "noul",
            instructions: string,          // kelimenin tam anlamıyla alınır
            criteria: … }                  // choice: {seçenek: rubrik|null}, score: [düzeyler]
  },
  route?: string                           // thresholds.yaml'daki route (eşik/telemetri anahtarı)
})
→ { answers: { <id>: { value, probabilities?, confidence?, } },
    meta: { model, request_id, latency_ms, cached, usage } }
```

- `choice` her pakette bir `other`/`none` kaçamağı içerir (zorunlu kural, şemada da doğrulanır).
- Çağrı başına **tek** HTTP isteği: fan-out yerel. Bağımlı yargılar → ardışık iki çağrı,
  ağırlıklandırma → kod.
- Yanıt normalliği: `confidence` yoksa (noul) `probability` alanı kullanılır; şema her ikisini
  ayrı döndürür, yorum route eşiklerine göre yapılır.

## 4. SKILL.md — kural katmanı

Skill, agent'a şu kuralları verir (tam metin implementasyonda yazılır):

1. **Ne zaman:** ≥5 paralel atomik yargı; güven eşiğiyle dallanacak karar; LLM'e pahalı gelen
   toplu triyaj (dosya, test, yorum, log).
2. **Ne zaman değil:** tek ve trivial karar; üretim/açıklama gerektiren iş; aritmetik/tarih/sayıma
   dayanan yargı; seçenek kümesinin kendisinin üretilmesi gerekiyorsa.
3. **Soru disiplini:** talimat literal (örtük koşul yok), atomik (tek yargı), `other` kaçamağı,
   state filtreli (ilgisisiz içerik accuracy düşürür), ≤255 seçenek (üstü iki aşamalı score).
4. **Yorum:** `act / confirm / escalate` eşikleri `thresholds.yaml`'dan okunur; "en iyi seçenek
   yeterliyse confidence'a değil olasılığa bak" (threshold-overuse uyarısı).
5. **Canlı doküman gerçeği:** versiyona bağlı ayrıntı için docs.typesafe.ai/llms.txt üzerinden
   güncel sayfa okunur; skill uydurma alan adı üretmemeli (resmi troubleshooting maddesi).

## 5. PreToolUse hook — risk kapısı

### 5.1 Akış

```
Bash komutu → (1) ucuz statik öneşleme: regex ile açıkça güvenli listeye al
                 (yalnız zincirsiz komutlara: ham komutta ;|&<>`() ve satır sonu varsa Jev'e gider)
            → (2) cache isabeti? (içerik hash'i: komut+cwd+git_dirty+model+soru paketi+mock/canlı kaynak)
            → (3) jev.decide tek çağrı, iki soru:
                 q_class : choice{safe, reversible, destructive, other}
                 q_conf  : noul("bu komut onay istemeli mi?")
            → (4) eşik tablosuyla birleştir → verdict
            → (5) telemetri satırı (karar + sonuç)
```

### 5.2 Verdict matrisi (escalate-only)

| q_class sonucu | q_conf | Verdict |
|---|---|---|
| destructive, confidence ≥ `destructive_block` (0.85) | — | **ask** (ek onay zorunlu) |
| safe, confidence ≥ `safe_note` (0.90) | düşük | **note** (not düşer, akış değişmez) |
| anlaşmazlık (choice↔noul) veya güven < `floor` (0.60) | — | **passthrough** (Jev'siz davranış) |
| herhangi bir hata/timeout/anahtar yok | — | **passthrough** (fail-open) |

Tasarım kararı: **`allow` kararı hook'tan asla gelmez.** Hook yalnızca `passthrough | note | ask`
üretebilir; izin azami ZCode izin sistemindedir. (Monotonic safety: kapı sadece yükseltir.)

### 5.3 Rollout: `off → shadow → active`

- `off`: hook kayıtlı değil.
- `shadow`: her şey çalışır, telemetriye `would=` alanı yazılır, akışa **sıfır** etkisi.
- `active`: verdict uygulanır.
- Geçiş kriteri: kalibrasyon dosyasında en az `N=50` gölge karar, `would` ile gerçekleşen
  sonuç uyuşmazlığı ≤ %5, destructive sınıfında yanlış-negatif sıfır. (ilk dikey:
  `rm -rf`, `git reset --hard`, `docker system prune`, force-push.)

## 6. Telemetri ve kalibrasyon

- `.jev/telemetry.jsonl` — her çağrı: `{ts, route, question_ids, answers, confidences,
  verdict, outcome?, request_id, latency_ms, cached, model}` (PII yok; state asla yazılmaz).
- `.jev/calibration.jsonl` — route başına ilk N karar + sonraki "sonucu ne oldu" kaydı.
  (firstmate deseni: sınıf sayacı + örneklem.)
- Eşik ayarlama döngüsü: kalibrasyona bak → thresholds.yaml güncelle → shadow'da doğrula →
  active. **Eşikler kodda asla sabit olmaz.**
- `x-typesafe-request-id` her zaman loglanır (hata bildirimi/denetim için).

## 7. Latency ve maliyet bütçesi

| Kullanım noktası | Yol | Bütçe |
|---|---|---|
| Hook risk kapısı | cache isabetli: ~0ms · isabetsiz: 70–500ms hedef, 5s üst sınır | kabul: hook zaten async; shadow'da ölçülür |
| Arama triyajı | 1 çağrı / karar noktası (fan-out) | agent adımı başına ≤1 çağrı kuralı |
| Yorum filtresi / test triyajı | 1 çağrı / toplu | aynı |
| Ağır kullanımda maliyet | girdi $0.042/Mtok, çıktı bedava | state filtresi + cache ile sınırlanır |

Kural: **senkron kritik yolda (kullanıcıya yanıt beklenirken) bloklayıcı çağrı yok.**
Karar noktaları arasına yerleştirilir; toplulaştırılamayan tekil karar LLM'de kalır.

## 8. Güvenlik

- Anahtar: öncelikle `JEV_API` ortam değişkeni (`TYPESAFE_API_KEY` yedek olarak kabul edilir;
  karar 2026-09-20), argv'ye asla (fd/env ile taşınır), repo/`.env`'e asla (firstmate deseni).
- Hook ve MCP server, state olarak yalnız filtrelenmiş, görevle ilgili içerik gönderir.
- Telemetri dosyaları `.jev/` altında, `.gitignore`'a önerilir (request_id kalır, içerik gitmez).

## 9. Açık kararlar — KAPANDI (0.2 implementasyon)

1. **Cache kapsamı → çözüldü (0.2.1'de sağlamlaştırıldı):** genel `decide` ve hook aynı
   mekanizmayı kullanır — `contentKey` içerik hash'i (canonical JSON: model+state+questions).
   Hook'ta state komut+cwd+git_dirty içerdiğinden anahtar bağlam duyarlıdır; anahtara ayrıca
   kaynak etiketi (mock/canlı + baseUrl) gömülür — mock sonuçlar canlı modda kullanılamaz.
   TTL route bazlı (öntanımlı 1h), çağrı bazlı `ttl_seconds` geçersiz kılar; 0 = cache yok.
   Süreç içi Map + `.jev/cache.json` kalıcılığı (hook kısa ömürlü süreç).
2. **Soru paketleri → çözüldü:** `questions/*.yaml` (use-cases.md §'leriyle birebir, generik
   kimlikler + `withPrefix` ile aday fan-out); `use-cases.md` referans doküman olarak sürer.
3. **Mock modu → çözüldü:** `JEV_MOCK=1` deterministik (girdi-hash'li PRNG), `JEV_MOCK_DELAY_MS`
   gecikme, `JEV_MOCK_FORCE` soru bazlı geçersiz kılma. Şema testleri mock ile yazıldı (69 test).
4. **Node/Python → çözüldü:** MCP server Node (sıfır npm bağımlılığı, stdio JSON-RPC elle).
   Hook tek girişli Node dosyası (`hooks/risk-gate.js`), paylaşılan `lib/` çekirdeğini kullanır
   ("tek dosya" hedefi girişe göre okunur; kod tekrarı yaratmamak için lib paylaşımı yeğlendi).

## 10. Implementasyon haritası (0.2)

| Dosya | Rol |
|---|---|
| `lib/yaml-mini.js` | thresholds + questions alt kümesi parser (akış `{|}` ve çok satırlı bilinçli olarak yok) |
| `lib/thresholds.js` | tek kaynak `docs/thresholds.yaml`; `JEV_THRESHOLDS` override; bilinmeyen route hata |
| `lib/validate.js` | şema §1: `JEV_E_NO_ESCAPE`, `JEV_E_STATE_TOO_LARGE`, `JEV_W_CODE_OP`, `JEV_W_DEPENDENT` |
| `lib/cache.js` | `contentKey` (+ mock/canlı kaynak etiketi) + TTL'li süreç-içi/dosya cache (best-effort) |
| `lib/telemetry.js` | `telemetry.jsonl` (state/soru metni ASLA) + `calibration.jsonl` (ilk N + outcome) |
| `lib/client.js` | `POST /v1/systemone` + retry/hata eşleme (§3) + `GET /v1/models` yoklama + mock |
| `lib/core.js` | paylaşılan karar hattı; `verdictOf` kancası ile hook verdict'i tek telemetri satırında |
| `mcp/server.js` | MCP stdio (initialize/ping/tools); hatalar `isError` + fail-open zarfı olarak döner |
| `hooks/risk-gate.js` | §5 akışı: statik öneşleme (bileşik komutlar muaf) → imza cache → Jev → §5.2 matrisi → shadow/active |
| `skills/jev-decide/SKILL.md` | §4 kural katmanı |
| Kurulum | `docs/install.md` (ZCode / Claude Code / Codex + rollout + doğrulama) |
