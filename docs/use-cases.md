# Kullanım Senaryoları ve Soru Paketleri

Her senaryo: tetik noktası → soru paketi (literal yazılmış `instructions`) → kodda birleştirme
→ eşik davranışı. Soru metinleri taslaktır; implementasyon öncesi elle gözden geçirilir
("agentlar soru yazmada iyi değildir" — resmi skill uyarısı).

Ortak kurallar: tek çağrı = karar noktası; `other` kaçamağı zorunlu; state filtreli;
aritmetik/tarih Jev'e sorulmaz, kod yapar.

---

## 1. Arama/keşif triyajı — `search.triage`

**Tetik:** grep/glob 20+ eşleşme döndürdü, agent hangi dosyaları okuyacağına karar veriyor.

**State (filtreli):** görev cümlesi + her aday dosya için: yol, ilk ~10 satır, sembol listesi.
(Aday başına ~300 token hedef.)

**Soru paketi (aday başına iki atomik soru, tek çağrıda fan-out):**

```jsonc
{
  "f14_relevant": {
    "type": "choice",
    "instructions": "Görev bu dosyanın değiştirilmesini gerektiriyor mu?",
    "criteria": {
      "directly":  "Dosya, görevin doğrudan değiştirdiği davranışı içeriyor",
      "likely":    "Dosya, görevle ilgili davranışı çağırıyor veya yapılandırıyor",
      "other":     "Yukarıdakilerin hiçbiri"
    }
  },
  "f14_role": {
    "type": "choice",
    "instructions": "Bu dosyanın projedeki rolü nedir?",
    "criteria": {
      "implementation": "İş mantığını uygular",
      "test":           "Testleri içerir",
      "config":         "Yapılandırma/derleme tanımıdır",
      "docs":           "Belgelendirmedir",
      "other":          "Yukarıdakilerin hiçbiri"
    }
  }
}
```

**Kodda birleştirme:** `directly|likely` olanları role göre grupla, `read_top_k` (5) kadarını
okuma listesine al; gerisi referans.
**Eşik:** confidence < 0.65 → o aday "belirsiz"e düşer; belirsiz oranı > %50 ise aramayı
genişlet (LLM'e dön). Hata → Jev'siz davranış (hepsini normal akışla değerlendir).

---

## 2. Kod yorumu şiddet filtresi — `review.comment_filter`

**Tetik:** agent inceleme bulguları üretti, `::code-comment` yaymadan önce.

**State:** diff parçası + bulgu metni + bağlam dosya adı.

**Soru paketi (bulgu başına):**

```jsonc
{
  "c7_would_act": {
    "type": "score",
    "instructions": "Bu bulgunun şiddeti nedir?",
    "criteria": [
      "stil-tercihi: bir maintainer büyük olasılıkla değişiklik istemez",
      "minör-iyileştirme: değişiklik iyi olur zorunlu değil",
      "düzeltilmeli: gerçek bir hata veya tutarlılık sorunu",
      "engelleyici: birleştirme öncesi mutlaka düzeltilmeli"
    ]
  },
  "c7_evidence": {
    "type": "noul",
    "instructions": "Bulgu, diff veya bağlamda gösterilen kanıtla doğrudan destekleniyor."
  }
}
```

**Kodda birleştirme:** `düzeltilmeli|engelleyici` VE noul=yes VE confidence ≥ `emit_comment`
(0.70) → yorum yayınlanır; değilse sessizce düşürülür. `max_comments_per_review` tavanı kodda.

---

## 3. Test hatası triyajı — `test.triage`

**Tetik:** test koşusu N failure döndürdü.

**State (failure başına filtreli):** test adı, assert çıktısı, son 20 satır log,
"son koşmada da mı başarısız" bilgisi (kod doldurur — tarih kıyaslaması Jev'e sorulmaz).

**Soru paketi:**

```jsonc
{
  "t3_class": {
    "type": "choice",
    "instructions": "Bu test başarısızlığının en olası sınıfı nedir?",
    "criteria": {
      "flaky":            "Testin kendisi tutarsız; aynı kodda aralıklı düşüyor",
      "environment":      "Ortam/bağımlılık sorunu; kod değişikliğiyle ilgisi yok",
      "real_regression":  "Bu değişiklik davranışı bozdu",
      "expected_change":  "Davranış kasıtlı değişti, test güncellenmeli",
      "other":            "Yukarıdakilerin hiçbiri"
    }
  },
  "t3_reproducible": {
    "type": "noul",
    "instructions": "Belirtiler bu başarısızlığın deterministik olduğunu gösteriyor."
  }
}
```

**Kodda birleştirme:** `flaky` + confidence ≥ 0.80 → tek retry; 0.60–0.80 → agent'a
"muhtemel flaky, doğrula" notu; `< 0.60` veya `real_regression` → systematic-debugging akışı.

---

## 4. PreToolUse risk kapısı — `hook.risk_gate`

**Tetik:** Bash aracı çağrıldı, komut statik güvenli listede değil.

**State:** normalize komut, cwd, repo durumu (working tree kirli mi — kod doldurur).

**Soru paketi (tek çağrı, iki soru):**

```jsonc
{
  "q_class": {
    "type": "choice",
    "instructions": "Bu komut çalışma dizininde veya sistemde hangi etkiyi yaratır?",
    "criteria": {
      "safe":         "Yalnızca okur veya geçici çıktı üretir; kalıcı değişiklik yok",
      "reversible":   "Kalıcı değişiklik yapar ama kolayca geri alınabilir",
      "destructive":  "Geri alınamaz veya geri alınması güç veri/durum kaybına yol açabilir",
      "other":        "Yukarıdakilerin hiçbiri"
    }
  },
  "q_conf": {
    "type": "noul",
    "instructions": "Bu komut çalıştırılmadan kullanıcıdan açık onay istenmeli."
  }
}
```

**Kodda birleştirme:** DESIGN.md §5.2 verdict matrisi (escalate-only: `passthrough | note | ask`).

---

## 5. Bitirme doğrulaması — `verify.checklist`

**Tetik:** agent "iş tamamlandı" demeden önce.

**State:** görev tanımı + gerçekleştirilen adımların özeti + test/lint komut çıktıları.

**Soru paketi (madde başına noul, tek çağrıda):**

```jsonc
{
  "v1_tests_ran":  { "type": "noul", "instructions": "Kanıt, testlerin bu oturumda gerçekten çalıştırıldığını gösteriyor." },
  "v2_files_match":{ "type": "noul", "instructions": "Değiştirilen dosya listesi, iddia edilen kapsamla uyumlu." },
  "v3_no_side":    { "type": "noul", "instructions": "Görev kapsamı dışında dosya veya davranış değişikliği belirtiliyor." },
  "v4_docs":       { "type": "noul", "instructions": "Değişiklik, kullanıcıya raporlanan doğrulama adımlarıyla destekleniyor." }
}
```

**Kodda birleştirme:** tümü yes + confidence ≥ `claim_done_on` (0.85) → tamamlandı;
0.60–0.85 bandında kalan madde → o adım yeniden çalıştırılır/kanıt toplanır; `< 0.60` → madde
"doğrulanamadı" olarak rapora yazılır (asla gizlenmez).

---

## 6. Adhoc kullanım — `adhoc`

Skill üzerinden, route belirtilmeyen ara kararlar (ör. "bu 12 log satırından hangileri aynı
hataya ait"). Tek kural: **geri alınamaz hiçbir aksiyon adhoc confidence ile tetiklenemez** —
adhoc çıktısı yalnızca agent'ın bir sonraki adımını *bilgilendirir*, tool çağrısı zincirini
`act` olarak açamaz. Hook içeren her çağrı adhoc olamaz (route zorunlu).

---

## Soru yazma kontrol listesi (her paket için)

- [ ] Her soru **tek** yargı mı? (gizli çok-parçalı → bölündü mü?)
- [ ] Talimat örtük koşul içeriyor mu? ("genelde", "makul şekilde" → çıkar)
- [ ] `choice` paketinde `other` kaçamağı var mı?
- [ ] Aritmetik/tarih/sayıma dayanan kısım koda mı taşındı?
- [ ] State filtrelendi mi? (ilgisiz içerik accuracy düşürür)
- [ ] ≤255 seçenek mi? (üstü → iki aşamalı score)
- [ ] Bağımlı yargılar aynı pakette mi? (ayrı çağrıya böl)
- [ ] Eşikler thresholds.yaml'dan mı okunuyor? (kodda sabit yok)
