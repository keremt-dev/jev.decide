# jev.decide — ZCode için Jev (TypeSafe.ai) Karar Katmanı

Bu proje, [TypeSafe.ai](https://docs.typesafe.ai/introduction)'nin **Jev** "System One" modelini
ZCode'a skill + MCP server + hook üçlüsü olarak entegre etmek için tasarım deposudur.

## Kısa amaç

LLM agent (ZCode) açık uçlu işleri yapsın; **filtrele / sırala / sınıflandır / eşikle** türünden
ara kararlar Jev'e gitsin: tipli değer + olasılık + kalibre güven ile, tek çağrıda toplu (fan-out),
fail-open garantisiyle.

## Tasarımın dört bileşeni

| Bileşen | Rol | Detay |
|---|---|---|
| MCP server (`jev`) | `decide` tool'u — `POST /v1/systemone` sarmalayıcısı, batch, retry, cache, telemetri | [docs/tool-schema.md](docs/tool-schema.md) |
| SKILL.md | Kural katmanı — ne zaman kullan / kullanma, soru disiplini, eşik okuma | [DESIGN.md](DESIGN.md) §4 |
| PreToolUse hook | Risk kapısı — yıkıcı komut tespiti, `off → shadow → active` geçişli | [DESIGN.md](DESIGN.md) §5 |
| Telemetri + kalibrasyon | Her kararın sınıf, güven ve sonuç kaydı; eşik ayarlama döngüsü | [DESIGN.md](DESIGN.md) §6 |

## Klasör yapısı

```
jev.decide/
  README.md               — bu dosya
  DESIGN.md               — mimari tasarım ve kararlar
  docs/
    tool-schema.md        — jev.decide MCP tool sözleşmesi (girdi/çıktı/hatalar)
    thresholds.yaml       — TÜM eşik ve mod değerleri (tek gözden geçirilebilir yer)
    use-cases.md          — somut senaryolar ve soru paketleri
    install.md            — ZCode / Claude Code / Codex kurulumu
  lib/                    — çekirdek (sıfır npm bağımlılığı, Node ≥ 18.17)
    yaml-mini.js          — mini YAML parser (thresholds + questions alt kümesi)
    thresholds.js         — eşik/mode yükleyici (JEV_THRESHOLDS override)
    validate.js           — girdi şeması doğrulama (yerel reddedilen girişler)
    cache.js              — içerik-hash + komut-imzası cache (TTL, dosya kalıcılığı)
    telemetry.js          — .jev/telemetry.jsonl + calibration.jsonl
    client.js             — Jev istemcisi: HTTP, retry, hata eşleme, JEV_MOCK modu
    core.js               — paylaşılan karar hattı (doğrula→cache→Jev→telemetri)
    questions.js          — soru paketi yükleyici
  mcp/server.js           — MCP stdio server "jev" (tool: decide)
  hooks/risk-gate.js      — PreToolUse risk kapısı (off→shadow→active, escalate-only)
  skills/jev-decide/SKILL.md — kural katmanı (ne zaman/ne zaman nasıl)
  questions/*.yaml        — elle gözden geçirilmiş soru paketleri (use-cases §'leriyle birebir)
  test/                   — node:test paketi (69 test; mock ile, API gerekmez)
  .mcp.json               — Claude Code yerel MCP kaydı
```

## Hızlı başlangıç

```bash
npm test                                        # 69 test, mock ile (anahtar gerekmez)
JEV_MOCK=1 node mcp/server.js                   # MCP server (stdio)
JEV_MOCK=1 node hooks/risk-gate.js < payload    # risk kapısı
```

Gerçek kullanım: `JEV_API` ortam değişkenine anahtarı ver (bekleme listesi sonrası).
Kurulum ve rollout: [docs/install.md](docs/install.md).

## Temel ilkeler (araştırma çıktısı)

1. **Fail-open.** Jev'e erişilemezse/hata olursa sistem Jev'siz davranışa döner. Karar katmanı
   kaldırılabilir olmalı, davranışı asla kötüleştirmemeli.
2. **Model seçenek kümesini yaratmaz.** Seçenekleri, eşikleri, ağırlıkları kod/config tanımlar;
   Jev yalnızca verilen seçenekler arasında tipli yargı üretir.
3. **Sorular ve eşikler tek yerde.** `thresholds.yaml` + `use-cases.md` içindeki soru paketleri.
   "Agentlar soru yazmada iyi değildir" (resmi skill'in kendi uyarısı) — sorular elle gözden geçirilir.
4. **Güven ikinci eksendir.** Karar = yanıt × güven × aksiyon riski → `act / confirm / escalate`.
5. **Aritmetik, tarih, sayma Jev'e sorulmaz.** Alan çıkarımı Jev, hesap kod.
6. **Latency bütçesi:** tek çağrı 70–500ms (rapor edilen). Döngü içinde yalnızca karar
   noktalarında, toplu (fan-out) tek çağrı; senkron kritik yolda değil.

## Kaynaklar (araştırma turundan)

- Resmi: [agent-skill](https://docs.typesafe.ai/agent-skill.md), [patterns](https://docs.typesafe.ai/patterns.md),
  [confidence-routing](https://docs.typesafe.ai/patterns/confidence-routing.md),
  [resmi skill reposu](https://github.com/typesafe-ai/skills) (yerel kopya: `../typesafe_skill.md`)
- Topluluk: [imajin-ai connector](https://github.com/ima-jin/imajin-ai/issues/2197) (service-connector ayrımı, retry),
  [gentle-ai router](https://github.com/Gentleman-Programming/gentle-ai/issues/4779) (confidence-gated, shadow mode),
  [firstmate triage](https://github.com/kunchenguid/firstmate/pull/4896) (fail-open + telemetri),
  [omni-dev best practices](https://github.com/rust-works/omni-dev/issues/1770) (soru disiplini),
  [isocan](https://github.com/dglazkov/isocan/issues/334) (70–500ms, denetlenebilirlik ilkesi)

## Durum

**v0.1 implementasyonu tamamlandı (2026-09-20), testlerle:** MCP server (`decide`), PreToolUse
risk kapısı (`off→shadow→active`, escalate-only), telemetri + kalibrasyon, içerik-hash cache,
soru paketleri ve skill katmanı. Harness-bağımsız: ZCode, Claude Code ve Codex'te çalışır
(Codex'te hook yok → fail-open, bkz. [docs/install.md](docs/install.md)).

API erişimi bekleme listesindeyse `JEV_MOCK=1` ile deterministik sahte yanıtlarla geliştirme
ve shadow testleri yapılır; anahtar `JEV_API` ortam değişkeninden okunur. Risk kapısı
`shadow` modda; `active` geçiş kriterleri DESIGN.md §5.3'te.
