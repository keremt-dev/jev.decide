# Düzeltme doğrulama raporu — 51610df

Tarih: 20.09.2026 · İncelenen yerel HEAD: `51610df` · Önceki sürüm: `0f0de6c`

## Sonuç

**82/82 test yeniden geçti. Ancak bütün bulguların kapandığı teyit edilemiyor.** Önceki dokuz bulgunun altısı özgün hata senaryosu bakımından kapandı; B03, B07 ve B08 kısmen giderildi. Dört küçük noktanın üçü kapandı; model yoklamasının timeout kısmı eksik. Ayrıca komut normalizasyonunda ayrı bir önbellek çakışması doğrulandı.

Bu incelemede kalan **5 düzeltme konusu** var: **1 P1, 4 P2**. Kaynak kod değiştirilmedi; yalnız bu rapor oluşturuldu. Kullanıcının bildirdiği canlı API testleri ve GitHub push işlemi bağımsız olarak tekrarlanmadı. Yerel commit ve davranışlar kontrol edildi.

## Önceki raporla eşleştirme

| Madde | Durum | Doğrulama |
|---|---|---|
| B01 — `ASK` / `ask` | Kapalı | Çıktı ve testler küçük harfli `ask`; mock hook testi geçti. Gerçek harness izin penceresi bu turda çalıştırılmadı. |
| B02 — yeni satırın yutulması | Kapalı, özgün senaryo | LF/CR korunuyor; `ls` + yeni satır + silme komutu değerlendirmeye gidiyor. Yatay boşluklarla ilgili ayrı kalan hata R05. |
| B03 — `git diff --output` | Kısmi | Düz yazılan iki biçim korunmuş; shell tırnaklamasıyla aynı seçenek hâlâ güvenli sayılıyor (R01). |
| B04 — mock/canlı cache karışması | Kapalı | Kaynak modu ve baseUrl anahtara dahil; geçiş testi geçti. |
| B05 — cwd/Git/model/soru bağlamı | Kapalı, özgün senaryo | Hook artık içerik anahtarı kullanıyor; aynı durum dizininde farklı cwd cache miss verdi. |
| B06 — off ve meta.mode | Kapalı | Off modda istemci/kayıt yok; başarı meta'sında mod var; testler geçti. |
| B07 — bozuk HTTP 200 cevabı | Kısmi | Eksik cevaplar reddediliyor; bazı geçersiz cevaplar yine kabul ediliyor (R02). |
| B08 — toplam süre/MCP kuyruğu | Kısmi | Retry toplam bütçeye bağlanmış; MCP seri işleme ve iptal sorunu sürüyor (R03). |
| B09 — 0.5 sınırında yanlış noul sınıfı | Kapalı, özgün senaryo | 0.4999 → no, 0.5/0.5001 → yes. Probability alanındaki hassasiyet notu aşağıda. |
| Küçük 1 — warnings | Kapalı | Başarı meta.warnings alanına taşınıyor. |
| Küçük 2 — probeModels | Kısmi | Model `name` alanı çözümleniyor; timeout gövde okumayı kapsamıyor (R04). |
| Küçük 3 — shadow smoke belgeleri | Kapalı | README/install artık sessiz shadow davranışını doğru açıklıyor. |
| Küçük 4 — YAML artan içerik | Kapalı | Parser tüm satırların tüketilmesini kontrol ediyor; regresyon testi geçti. |

## Kalan bulgular

### R01 — P1 — Tırnaklanan `--output` seçeneği statik güvenli sayılıyor

**Konum:** `docs/thresholds.yaml:35`, `hooks/risk-gate.js:125–134`.

Yeni `^git diff(?!.*--output[= ])` deseni ham shell metninde düz `--output` arıyor. Shell tırnakları kaldırdıktan sonra aynı Git seçeneğini oluşturan şu iki komut desenin engeline takılmıyor:

```text
git diff '--output'=valuable.txt
git diff --out'put'=valuable.txt
```

**Kanıt:** Active modda destructive=0.99 zorlanmış mock ile her iki girdi de boş stdout ve `reason=static_safe` üretti. Bağımsız incelemeci yalnız geçici bir depodaki deneme dosyasında Git Bash ile gerçek davranışı kontrol etti: iki biçim de exit=0 ile dosya içeriğini sıfırladı. `git diff --output='x'` ise doğru biçimde değerlendirmeye gidiyor. `--out=x` Git tarafından reddedildiğinden bulguya dahil edilmedi.

**Etki:** Yazma etkisi olan komut Jev'e ulaşmadan güvenli kabul ediliyor. Ana harness izinleri ayrıca geçerlidir; sorun ek risk kapısının değerlendirmeyi atlamasıdır.

**Öneri:** Shell sözdizimini ayrıştırıp seçenekleri argüman düzeyinde değerlendirin veya statik güvenli yolu yalnız açıkça desteklenen basit, tırnaksız salt okunur biçimlerle sınırlayın. Yeni blacklist varyantları eklemekle yetinmeyin. İki tırnaklı örneği regresyon kapsamına alın.

### R02 — P2 — Normalizasyondan sonraki kontrol geçersiz yanıtları kaçırıyor

**Konum:** `lib/client.js:121`, `:130`, `:286`, `:293–295`.

İki ayrı kaçak aynı yanıt doğrulama sınırında bulunuyor:

- Choice üyeliği `a.value in criteria` ile kontrol ediliyor. Bu kontrol prototipten gelen `toString` gibi adları da kabul ediyor.
- Normalizasyon geçersiz ham değerleri doğrulama öncesinde dönüştürüyor: string confidence → null; aralık dışı noul olasılığı → yuvarlanmış geçerli sayı.

**Offline HTTP 200 kanıtları:** Enjekte edilmiş yanıtların tamamı `JevClient.decide()` tarafından hata verilmeden kabul edildi:

| Ham cevap | Kabul edilen normal cevap |
|---|---|
| `{choice:'toString', confidence:0.9}`; seçenekler yalnız safe/other | `value:'toString'` |
| `{choice:'safe', confidence:'invalid', probabilities:{safe:0.9}}` | `confidence:null` |
| `{noul:1.0001}` | `value:'yes', probabilities:{yes:1,no:0}` |

**Etki:** Geçersiz model yanıtı geçerli karar gibi kullanılabilir ve pipeline tarafından cache'e yazılabilir. Özellikle bozuk confidence bilgisinin null'a dönüşmesi, hook'un probability fallback yolunu açabilir.

**Öneri:** Ham API cevabını normalizasyondan önce doğrulayın; choice için string tipini ve `Object.hasOwn(criteria, value)` üyeliğini kontrol edin. Noul için ham sayının sonlu ve [0,1] içinde olduğunu doğrulayın. Bozuk confidence ile eksik confidence aynı durum olarak ele alınmamalı. Cache'e yazılmadığını pipeline düzeyinde de test edin.

### R03 — P2 — MCP'de ping ve iptal hâlâ karar kuyruğunda bekliyor

**Konum:** `mcp/server.js:124`, `:177–188`.

İstemcinin toplam retry bütçesi düzeltilmiş, fakat MCP sunucu dosyası bu commit'te değişmemiş. Döngü her mesaj için `await handle(msg)` bekliyor. `notifications/cancelled` işlense bile yürüyen isteğe aktarılmadan yok sayılıyor.

**Kanıt:** Ayrı stdio sürecine, her biri 300 ms gecikmeli ve cache kapalı üç mock karar isteği, ardından ping gönderildi:

```json
[
  {"id":1,"elapsed":407},
  {"id":2,"elapsed":715},
  {"id":3,"elapsed":1051},
  {"id":4,"elapsed":1051}
]
```

Ping bütün kararlar bittikten sonra yanıtlandı. Süreler bu denemeye özgüdür. Toplam süre sınırı tek isteğin süresini sınırlar; kuyruğun birikmesini çözmez.

**Öneri:** Mesaj okumayı uzun karar işinden ayırın; sınırlı eşzamanlılık ve istek kimliğine bağlı iptal uygulayın. Gerçek stdio döngüsünde uzun karar + ping + iptal testleri ekleyin. Mevcut MCP testleri çoğunlukla doğrudan handler çağırdığından bu davranışı yakalamıyor.

### R04 — P2 — `probeModels` timeout'u yalnız HTTP başlıklarına kadar geçerli

**Konum:** `lib/client.js:164–173`.

Timer, `fetch` döndüğünde `finally` içinde temizleniyor; `res.json()` bundan sonra çağrılıyor. Sunucu başlıkları gönderip gövdeyi geciktirdiğinde süre sınırı artık uygulanmıyor.

**Kanıt:** Enjekte edilmiş fetch hemen yanıt nesnesi döndürdü; json gövdesi 120 ms geciktirildi. `timeoutMs:20` verilmesine rağmen çağrı yaklaşık **127 ms** sonra başarıyla döndü; `signal.aborted=false` kaldı.

**Öneri:** Gövde okuma ve çözümleme tamamlanana kadar timer'ı koruyun. Testte yalnız `opts.signal` varlığını kontrol etmek yeterli değil; geciken başlık ve geciken gövde senaryolarını ayrı çalıştırın.

### R05 — P2 — Tırnak içi yatay boşluklar komut anlamını ve cache anahtarını değiştiriyor

**Konum:** `hooks/risk-gate.js:46–47`, `:153`.

`/[ \t]+/g` normalizasyonu shell tırnaklarını tanımıyor. Farklı dosya adlarını hedefleyen iki komut aynı metne indirgeniyor:

```text
rm -- 'important  data'
rm -- 'important data'
```

**Kanıt:** Ortak durum dizininde ilk komuta safe mock sonucu yazıldı. İkinci komutta mock destructive olarak değiştirildi; yine de `cached=true`, `verdict=note` ve boş stdout görüldü. İki dosya hedefi farklı olmasına rağmen ikinci komut yeniden değerlendirilmedi. Komutlar yalnız hook girdisi olarak kullanıldı; dosya silme çalıştırılmadı.

**Öneri:** Ham komutu hem model girdisinde hem cache anahtarında koruyun veya shell ayrıştırmasına dayanan, anlamı koruduğu kanıtlı bir normalizasyon kullanın. Tırnak içi tek/çift boşluk ve tab varyantlarını test edin. Bu, kapanan B02 yeni satır senaryosundan ayrı bir kalan hatadır.

## Hassasiyet ve test kapsamı notları

- B09'un özgün yes/no sınıflandırma hatası düzeldi. Ancak `probabilities` hâlâ üç basamağa yuvarlanıyor. `noul:0.8499` → `probabilities.yes:0.85`; tüketici bu alanı 0.85 eşiğinde karşılaştırırsa sınıra yanlış taraftan geçebilir. Bu alan makine tüketimine açık olduğundan yuvarlamayı yalnız UI gösterimine taşımak daha doğru olur.
- “Her düzeltmenin regresyon testi eklendi” ifadesinin kapsamı sınırlı: probe testi gövde timeout'unu, MCP testleri stdio kuyruk davranışını, B07 testi ise cache yazımını doğrudan sınamıyor. Test adındaki iddia, yapılan assertion ile aynı değil.
- Kaynak düzeltmeleri ve 82 testlik başarı doğrulandı. Bu rapor canlı Jev doğruluğu, gerçek harness izin penceresi veya GitHub uzak branch durumu için yeni kanıt oluşturmaz.

## Doğrulama kapsamı

`npm test`: 82 başarılı, 0 başarısız, 0 atlanan. Ek repro'lar dış servise bağlanmadan enjekte edilmiş HTTP/sleep veya mock süreçlerle çalıştırıldı; durum dosyaları sistem geçici dizinlerine yönlendirildi. Kaynak dosyalarda değişiklik yapılmadı. Önceki rapor korunmuştur.
