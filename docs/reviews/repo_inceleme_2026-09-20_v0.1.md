# jev.decide — Repo inceleme raporu

Tarih: 20.09.2026 · Sürüm: v0.1 · İncelenen commit: `0f0de6c`

## Sonuç

**9 hata/risk bulgusu: 4 yüksek öncelikli (P1), 5 orta öncelikli (P2).** Ayrıca 4 küçük iyileştirme noktası var. Mevcut 70 test geçiyor; aşağıdaki sınır durumları bu testlerin dışında kalıyor. Risk kapısının `active` kullanımından önce özellikle B01–B05 ele alınmalı.

İnceleme kaynak kodu, testler, yapılandırma, soru paketleri ve kullanım belgelerini kapsar. Kaynak dosyalar düzeltilmedi. Bu rapor yeni dosya olarak eklendi.

## Yöntem ve kanıt sınırları

- Ortam: Windows / PowerShell, Node.js `v24.13.0`.
- `npm test`: **70/70 başarılı**, başarısız/atlanan test yok.
- Hook/cache/threshold alt kümesi ayrıca bağımsız incelemeci tarafından çalıştırıldı: **21/21 başarılı**; bu 21 test toplam 70'in içindedir.
- Ek doğrulamalar: enjekte edilmiş HTTP yanıtları, bellekte önbellek, mock hook süreçleri ve MCP stdio süreci. Gerçek Jev API çağrısı yapılmadı; API anahtarı okunmadı.
- Tehlikeli görünen komutlar hook'a **metin girdi** olarak verildi, çalıştırılmadı. B03'teki Git davranışı yalnız yeni, geçici bir depoda oluşturulan deneme dosyası üzerinde doğrulandı.
- B01 için resmî Claude Code hook sözleşmesi kontrol edildi. Gerçek Claude Code/ZCode izin penceresiyle uçtan uca doğrulama yapılmadı.
- README'deki önceki canlı API doğrulama iddiaları bu incelemede yeniden doğrulanmış sayılmaz. Node 18.17 uyumluluğu ayrıca çalıştırılmadı.
- Başlangıçta Git çalışma ağacı temizdi. İnceleme sonunda mevcut izlenen dosyalarda fark olmadığı kontrol edildi.

P1: Temel risk değerlendirmesini/entegrasyonu yanlış çalıştırabilir; aktif kullanımdan önce düzeltme önerilir. P2: Belirli koşullarda yanlış sonuç, yapılandırma davranışı veya hizmet gecikmesi yaratır. Bulgular, ana uygulamanın mevcut izin sisteminin aşıldığı anlamına gelmez; bu katmanın ek değerlendirme/onay işlevindeki eksikleri gösterir.

## Bulgular

### B01 — P1 — Hook onay kararı sözleşmeyle uyumsuz

**Konum:** [hooks/risk-gate.js:198](../../hooks/risk-gate.js#L198), [test/hook.test.js:65](../../test/hook.test.js#L65).

Active modda yüksek güvenli `destructive` yanıtı için `permissionDecision: "ASK"` üretiliyor. Claude Code sözleşmesindeki değer küçük harfli `"ask"`. Dolayısıyla hook'un çıktısı geçerli onay isteği biçiminde değil; mevcut test de aynı yanlış büyük harfli değeri beklediği için hatayı yakalamıyor.

**Kanıt:** Offline active + destructive mock denemesi stdout'ta `"ASK"` üretti. Resmî sözleşme `"ask"` değerini tanımlıyor: [Claude Code — PreToolUse decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control).

**Öneri:** Çıktı ve test beklentisini `ask` yapın. Çıktıyı harness sözleşmesine göre doğrulayan bir test ve gerçek harness ile tek onay akışı testi ekleyin. ZCode uyumluluğunu kendi sözleşmesiyle ayrıca doğrulayın.

### B02 — P1 — Yeni satırla zincirlenen komutlar güvenli sayılıyor

**Konum:** [hooks/risk-gate.js:45](../../hooks/risk-gate.js#L45), [hooks/risk-gate.js:124](../../hooks/risk-gate.js#L124).

`normalizeCommand()` bütün boşluk karakterlerini tek boşluğa indiriyor. Zincirleme kontrolü bundan sonra yapıldığı için yeni satır artık görünmüyor. Bash'te iki ayrı komut olan aşağıdaki girdi `ls rm -rf /tmp/important` haline geliyor ve `^ls( |$)` güvenli deseniyle eşleşiyor:

```text
ls
rm -rf /tmp/important
```

**Kanıt:** Active mod, `destructive=0.99` mock ayarıyla çıktı boş; telemetride `reason=static_safe`, `verdict=passthrough`. Jev değerlendirmesine hiç ulaşılmıyor. Ham komutun anlamı modele gönderilen `state.command` içinde de kayboluyor.

**Öneri:** Zincirleme kontrolünü ham komutta yapın; değerlendirme için ham komutu koruyun. Önbellek normalizasyonu shell sözdizimini değiştirmemeli. LF/CRLF ve tırnak içindeki anlamlı boşluklar için regresyon testleri ekleyin.

### B03 — P1 — Güvenli `git diff` deseni dosya üzerine yazmayı da kapsıyor

**Konum:** [docs/thresholds.yaml:35](../../docs/thresholds.yaml#L35), [hooks/risk-gate.js:125](../../hooks/risk-gate.js#L125).

`^git diff` deseni bütün seçenekleri güvenli kabul ediyor. Oysa `git diff --output=important.txt` çıktıyı dosyaya yazar; mevcut içeriğin kaybolmasına yol açabilir. Shell yönlendirme karakteri içermediğinden `hasChaining()` de bunu elemiyor.

**Kanıt:** Bu girdi active/destructive mock ile `static_safe` olarak geçti. Bağımsız incelemeci geçici bir Git deposunda `valuable.txt` içindeki deneme metninin `git diff --output=valuable.txt` sonrasında boş dosyaya dönüştüğünü doğruladı; çıkış kodu 0.

**Öneri:** Salt okunur komut biçimlerini seçenekleriyle birlikte sınırlandırın; bilinmeyen veya yazma/haricî program çalıştırma seçeneklerini değerlendirmeye gönderin. `--output=...` ve `--output ...` biçimlerini test edin.

### B04 — P1 — Mock sonuçlar canlı modda önbellekten kullanılabiliyor

**Konum:** [lib/core.js:53](../../lib/core.js#L53), [lib/core.js:58](../../lib/core.js#L58), [lib/core.js:73](../../lib/core.js#L73).

Önbellek anahtarı model/state/questions içeriyor ancak mock/canlı ayrımını içermiyor. Mock sonuçlar da aynı cache'e yazılıyor. Aynı durum dizininde mock denemesinden sonra canlı moda geçildiğinde eski sahte yanıt TTL boyunca geçerli sonuç olarak dönebiliyor. Hook kararında `meta.mock` kontrolü yok.

**Kanıt:** Aynı girdi ve paylaşılan `Cache` ile önce mock pipeline, sonra `mock:false` ve enjekte edilmiş HTTP istemcisi çalıştırıldı:

```json
{"liveCalls":0,"ok":true,"cached":true,"model":"jev-mock-1.0","mock":true}
```

Bu davranış sahte kararları ve kalibrasyon verisini canlı kullanımda taşıyabilir. `JEV_BASE_URL` değişimi de anahtar kapsamında değil.

**Öneri:** Mock cache'i ayrı tutun veya kalıcı yazımını kapatın. Canlı cache okumasında kaynak modunu doğrulayın; servis/model/soru sürümü ayrımını açıklaştırın. Mock→canlı ve canlı→mock geçişleri için test ekleyin. Anahtarı ayrıştırırken API anahtarını kaydetmeyin.

### B05 — P2 — Hook cache anahtarı çalışma bağlamını dışlıyor

**Konum:** [hooks/risk-gate.js:151](../../hooks/risk-gate.js#L151), [hooks/risk-gate.js:156](../../hooks/risk-gate.js#L156).

Modele komutla birlikte `cwd` ve `git_dirty` gönderiliyor, fakat cache anahtarı yalnız komut imzası. Aynı çalışma dizininde Git durumu değişse bile önceki karar yeniden kullanılıyor. Ortak `JEV_STATE_DIR` kullanılıyorsa projeler arasında da taşınabiliyor. Model ve soru paketi değişiklikleri de hook anahtarını değiştirmiyor.

**Kanıt:** Aynı durum dizininde `git reset --hard` komutu için ilk hook girdisi cwd=`C:/project-a`, zorlanmış yanıt=`safe`; ikinci girdi cwd=`C:/project-b`, zorlanmış yanıt=`destructive`. İkinci sonuç `cached=true`, `q_class=safe`, `verdict=note`, stdout boş. Bu, gerçek modelin ne karar vereceğini göstermez; değişen bağlamda yeniden değerlendirme yapılmadığını gösterir.

**Öneri:** Anahtarı komut + cwd + kullanılan Git bağlamı + model + soru paketi içeriğinden üretin. Aynı komutun temiz/kirli çalışma ağacında tekrarını ve ortak durum dizinindeki iki projeyi test edin.

### B06 — P2 — MCP karar hattı `off` modunu uygulamıyor; başarı çıktısında mod yok

**Konum:** [lib/core.js:40](../../lib/core.js#L40), [lib/core.js:69](../../lib/core.js#L69), [lib/core.js:105](../../lib/core.js#L105).

Hook girişinde `off` kontrolü bulunuyor, ancak paylaşılan pipeline/MCP yolunda bulunmuyor. Rota `off` olsa da API çağrısı ve kayıt üretimi sürüyor. Ayrıca başarılı cevapta `meta.mode` verilmediği için MCP tüketicisi sonuçtan shadow/active ayrımını göremiyor. Yapılandırmadaki kapatma davranışı iki giriş noktası arasında tutarsız.

**Kanıt:** `adhoc.mode='off'` ile enjekte edilmiş istemci çağrı sayısı 1; çıktı `ok:true`; `meta.mode` yok. Telemetri çağrısı da pipeline'da koşulsuz.

**Öneri:** `off` için çağrı/kayıt politikasını pipeline düzeyinde uygulayın. Başarı çıktısına `mode` ekleyin ve shadow sonucunun aksiyona dönüştürülmemesi kuralını tüketici sözleşmesinde belirtin. MCP üzerinden off/shadow/active testleri ekleyin.

### B07 — P2 — Eksik API cevabı başarılı sayılıp cache'e yazılıyor

**Konum:** [lib/client.js:131](../../lib/client.js#L131), [lib/client.js:203](../../lib/client.js#L203), [lib/core.js:73](../../lib/core.js#L73).

HTTP 200 cevabındaki yanıtların istenen soruları kapsadığı veya değerlerin şemaya uyduğu doğrulanmıyor. `normalizeAnswers(undefined)` boş nesne döndürüyor; pipeline bunu başarı sayıp önbelleğe alıyor. Tipli karar sözleşmesi bozulduğu halde tüketici hata/fallback işareti alamıyor.

**Kanıt:** Enjekte edilmiş `HTTP 200` / `{}` yanıtı:

```json
{"ok":true,"answers":{},"meta":{"model":null,"cached":false}}
```

**Öneri:** Önbelleğe yazmadan önce soru kimliklerini, cevap türlerini, seçenek üyeliğini ve olasılık/güven aralıklarını doğrulayın. Eksik veya bozuk cevapları hata zarfıyla döndürün; cache'e almayın. Kısmi yanıt ve boş gövde senaryolarını test edin.

### B08 — P2 — Retry beklemesi MCP kuyruğunu uzun süre durdurabiliyor

**Konum:** [lib/client.js:59](../../lib/client.js#L59), [lib/client.js:65](../../lib/client.js#L65), [mcp/server.js:177](../../mcp/server.js#L177), [mcp/server.js:188](../../mcp/server.js#L188).

`request_timeout_ms` her HTTP denemesinde yeniden başlıyor; retry uykusu toplam bir süre bütçesine bağlı değil. MCP stdio döngüsü her mesajı `await handle(msg)` ile bitirip sonraki mesaja geçiyor. Uzun retry beklemesi başka kararları, ping'i ve iptal bildirimlerinin okunmasını geciktiriyor. Hook'un dış süre sınırı var; bu bulgu özellikle MCP yoluyla ilgili.

**Kanıt:** Enjekte edilmiş dört `429` cevabı ve `Retry-After: 60` için 5.000 ms timeout ayarına rağmen uyku talepleri `[60000,60000,60000]`, toplam **180.000 ms**. Gerçek bekleme yapılmadı; sleep enjekte edildi. Ayrı stdio deneyinde 400 ms mock gecikmeli karar ve hemen ardından ping gönderildi; ikisinin yanıtı da yaklaşık **509 ms** sonra geldi.

**Öneri:** Çağrı bazında toplam deadline uygulayın; retry beklemesi kalan bütçeyi aşıyorsa fallback dönün. MCP mesajlarını sınırlı eşzamanlılıkla işleyin ve iptali yürüyen isteğe bağlayın. Gecikmeli karar sırasında ping ve ikinci istek testleri ekleyin.

### B09 — P2 — Noul yuvarlaması evet/hayır sonucunu tersine çevirebiliyor

**Konum:** [lib/client.js:216](../../lib/client.js#L216).

`raw.noul` önce üç ondalığa yuvarlanıyor, sonra `p >= 0.5` ile sınıflandırılıyor. Dolayısıyla 0.5 altındaki bazı değerler `yes` oluyor. Yanıt normalizasyonu, orijinal olasılığın kararını değiştiriyor.

**Kanıt:** `normalizeAnswers({q:{noul:0.4999}})` sonucu:

```json
{"q":{"value":"yes","probabilities":{"yes":0.5,"no":0.5},"confidence":null}}
```

**Öneri:** Kararı ham doğrulanmış olasılıktan üretin. Eşik karşılaştırmaları için hassasiyeti koruyun; yuvarlamayı yalnız gösterim katmanına bırakın. 0.4999 / 0.5 / 0.5001 sınır testleri ekleyin.

## Daha küçük düzeltme noktaları

1. **Doğrulama uyarıları tüketiciye ulaşmıyor.** `lib/validate.js` uyarı listesi döndürüyor, fakat `lib/core.js:45` bunu atıyor. `JEV_W_CODE_OP` ve `JEV_W_DEPENDENT` sadece doğrudan validator testlerinde görünür. Uyarıları başarı meta'sına veya ayrı gözlemlenebilir alana taşıyın.
2. **Model yoklama normalizasyonu `name` alanını almıyor.** `lib/client.js:100`, belgede belirtilen `{models:[{name:'jev-latest'}]}` için string yerine nesne döndürüyor. Enjekte edilmiş yanıtta bu doğrulandı; `mcp/server.js:169` model adlarını `[object Object]` şeklinde loglayabilir. `id/name` alanlarını açıkça ele alın; yoklamaya da süre sınırı koyun.
3. **Başlangıç örneğinin beklenen çıktısı hatalı.** `README.md:39` ve `docs/install.md:102` varsayılan mock komutunun ASK çıktısı üreteceğini söylüyor; dağıtılan rota shadow olduğundan hook `hooks/risk-gate.js:189` satırında sessiz çıkar. Örneği shadow telemetrisiyle anlatın veya ayrı, geçici active test yapılandırması gösterin.
4. **YAML parser belge sonunu kontrol etmiyor.** `lib/yaml-mini.js:23`, parser'ın `next` konumunu yok sayıyor. `parse('  a: 1\nb: 2\n')` yalnız `{a:1}` döndürüyor; kalan içerik için hata üretmiyor. Tüm satırların tüketildiğini kontrol edin ve hatalı girintiyi açıkça reddedin. Dağıtılan mevcut YAML dosyalarında bu biçim görülmedi.

## Düzeltme ve doğrulama sırası

1. B01–B03: Hook çıktı sözleşmesi ve statik güvenli komut denetimi.
2. B04–B05: Mock/canlı ve bağlam ayrımı olan cache anahtarları; eski cache kayıtlarının geçersizleştirilmesi.
3. B06–B09: Mod davranışı, cevap doğrulaması, toplam süre sınırı ve olasılık hassasiyeti.
4. Küçük düzeltmeler ve bunları yakalayan odaklı testler; ardından tüm test paketi ve gerçek harness onay akışı doğrulaması.

Mevcut testlerin geçmesi olumlu bir başlangıçtır; özellikle B01'de testin yanlış sözleşmeyi doğruladığı görülüyor. Canlı API'nin cevap vermesi veya hook'un JSON basması, gerçek harness'in ek onayı uyguladığını tek başına kanıtlamaz.

