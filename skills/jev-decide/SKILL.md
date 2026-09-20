---
name: jev-decide
description: Toplu tipli kararları (filtrele / sırala / sınıflandır / eşikle) Jev'e (TypeSafe.ai System One) delege et — ≥5 paralel atomik yargı, güven eşiğiyle act/confirm/escalate dallanması, toplu triyaj (dosya, test, yorum, log). Aritmetik, tarih, sayma, tekil trivial karar ve üretim/açıklama gerektiren işler için KULLANMA.
---

# jev-decide — Jev karar katmanı kullanım kuralları

Jev, tipli değer + olasılık + kalibre güven üreten bir karar servisidir. Beynin (model seçimi,
planlama, kod üretimi, özetleme) DEĞİLDİR. Seçenekleri, eşikleri, ağırlıkları sen/kod tanımlar;
Jev yalnızca verilen seçenekler arasında yargı üretir.

## 1. Ne zaman kullan

- **≥5 paralel atomik yargı:** 20 grep eşleşmesinden hangi dosyalar okunmalı — her aday için
  aynı soru. Tek çağrıda fan-out et.
- **Güven eşiğiyle dallanacak karar:** "flaky ise retry et, regression ise debug akışına geç"
  gibi. Eşik `thresholds.yaml`'dadır, burada değil.
- **LLM'e pahalı gelen toplu triyaj:** dosya, test sonucu, yorum şiddeti, log satırı sınıflandırma.

## 2. Ne zaman KULLANMA

- Tek ve trivial karar (tek dosya okunacak mı? — kendin karar ver).
- Üretim/açıklama gerektiren iş (özetle, yaz, açıkla).
- **Aritmetik, tarih karşılaştırma, sayma** — bunlar koddur. Alan çıkarımı Jev, hesap kod.
- Seçenek kümesinin kendisi üretilmesi gerekiyorsa (Jev seçenek yaratmaz).

## 3. Nasıl çağrılır

| Harness | Tool adı |
|---|---|
| ZCode / Claude Code | `mcp__jev__decide` |
| Codex | `jev` server'ının `decide` aracı |

```
decide({
  state: <filtrelenmiş bağlam — string|object|array, hedef ≤ ~32k token>,
  questions: {
    <id>: { type: "choice", instructions: "...", criteria: { <seçenek>: "<rubrik>", other: "..." } }
    <id>: { type: "score",  instructions: "...", criteria: ["düşükten", ..., "yükseğe"] }
    <id>: { type: "noul",   instructions: "<tek evet-hayır iddiası>" }
  },
  route: "<thresholds.yaml'daki route; verilmezse adhoc>"
})
→ { answers: { <id>: { value, probabilities, confidence } }, meta: { route, floor, thresholds, cached, ... } }
```

Hazır soru paketleri `questions/*.yaml` dosyalarındadır (arama triyajı, test triyajı, yorum
filtesi, bitirme doğrulaması, risk kapısı). Yeni paket yazacaksan `docs/use-cases.md` sonundaki
kontrol listesinden geçir — **agentlar soru yazmada iyi değildir**; sorular elle gözden geçirilir.

## 4. Soru disiplini (çağrı reddedilebilir)

- Talimat **literal**: örtük koşul yok ("genelde", "makul şekilde" → çıkar).
- Soru **atomik**: tek yargı. Gizli çok-parçalı → böl.
- `choice` paketinde **`other`/`none_of_the_above` kaçamağı zorunlu** (yoksa `JEV_E_NO_ESCAPE`).
- `state`'i filtrele: ilgisi içerik doğruluğu düşürür. Aday başına ~300 token hedefle.
- ≤255 seçenek; üstü iki aşamalı `score`. Bağımlı yargılar → ayrı çağrılar (ardışık iki çağrı).
- Ağırlıklandırma → kodda birleştir; tek çağrı = tek karar noktası.

## 5. Yanıtın yorumu

Eşikler yanıtta gelir: `meta.floor`, `meta.thresholds` (kaynak: `docs/thresholds.yaml`).

- `confidence < floor` → **asla otomatik act yok** → escalate / insan onayı.
- Karar = yanıt × güven × aksiyon riski → `act / confirm / escalate`:
  - `act`: geri alınabilir adım + güven ≥ route eşiği.
  - `confirm`: güven bandı içinde → kullanıcıya/kanıta doğrulat.
  - `escalate`: güven tabanı altı veya geri alınamaz + belirsiz → yüksek seviyeye bırak.
- **Threshold-overuse uyarısı:** en iyi seçenek yeterince olaysa (`probabilities` yüksek)
  confidence'a bakıp aşırı escalade etme — olasılığa bak.
- `noul` yanıtlarında `confidence` yoktur; `probabilities.yes/no` ile yorumla.

## 6. Fail-open sözleşmesi

- Hata dönmesi normaldir: `ok:false` + `error.code` (`JEV_E_AUTH`, `JEV_E_UNAVAILABLE`,
  `JEV_E_RATE_LIMIT`, ...) + `meta.verdict_suggestion: "passthrough"`.
  Akışı DURDURMA — Jev'siz davranışa dön (normal akışla kendin karar ver).
- **Geri alınamaz hiçbir aksiyon adhoc confidence ile tetiklenemez.** Adhoc çıktısı yalnızca
  bir sonraki adımı bilgilendirir; tool zincirini `act` olarak açamaz.
- Hook içeren hiçbir şey adhoc olamaz — risk kapısı `hook.risk_gate` route'unu kullanır.
- Senkron kritik yolda (kullanıcı yanıtı beklenirken) bloklayıcı çağrı koyma; karar noktaları
  arasına yerleştir, toplulaştır.

## 7. Canlı doküman gerçeği

Versiyona bağlı ayrıntı için `https://docs.typesafe.ai/llms.txt` üzerinden güncel sayfayı oku.
API alan adı uydurma — emin olmadığın alanı dokümandan doğrula.

## 8. Ortam ve gözlemlenebilirlik

- Anahtar `JEV_API` ortam değişkenindedir (kod/argv/repoda asla).
- `JEV_MOCK=1` ile deterministik sahte yanıt (geliştirme/shadow testi).
- Her çağrı `.jev/telemetry.jsonl`'ye yazılır (state/soru metni ASLA yazılmaz, yalnız kimlikler).
  Eşik önerisi için `.jev/calibration.jsonl`'ye bak.
