# Kurulum — ZCode / Claude Code / Codex

Çekirdek harness-bağımsızdır: **MCP server (stdio)** + **skill** + **PreToolUse hook**.
Üçünün hepsi sıfır npm bağımlılığıyla çalışır (Node ≥ 18.17, yerleşik `fetch`).

## Ortam değişkenleri (üç harness için ortak)

| Değişken | Anlam |
|---|---|
| `JEV_API` | TypeSafe.ai API anahtarı (**yeğlenen**). `TYPESAFE_API_KEY` yedek olarak kabul edilir. |
| `JEV_MOCK` | `1` → HTTP yerine deterministik sahte yanıt (anahtar gerekmez). |
| `JEV_MOCK_FORCE` | Mock yanıtı soru bazlı geçersiz kılar: `{"q_class":{"value":"destructive","confidence":0.93}}` (shadow testleri). |
| `JEV_MOCK_DELAY_MS` | Mock gecikme enjeksiyonu. |
| `JEV_BASE_URL` | Varsayılan `https://api.typesafe.ai` (yerel proxy/test için). |
| `JEV_THRESHOLDS` | `thresholds.yaml` yolunu geçersiz kılar (varsayılan: repo içi `docs/thresholds.yaml`). |
| `JEV_STATE_DIR` | `.jev/` (telemetri/cache) dizinini taşıma. |

Çalışma zamanı durumları `.jev/` altında (cwd'ye göreli): `telemetry.jsonl`, `calibration.jsonl`,
`cache.json`. `.gitignore`'a ekleyin.

Aşağıdaki örneklerde `<REPO>` = bu deponun mutlak yolu (ör. `C:/kt/jev.decide`).

## Claude Code

**MCP:**

```bash
claude mcp add jev --env JEV_API=<anahtar> -- node <REPO>/mcp/server.js
```

(Proje yerel alternatifi: repo kökündeki `.mcp.json` hazır — dizini açıp `claude` çalıştırın.)

**Skill:** `skills/jev-decide/` dizinini `~/.claude/skills/jev-decide` (kullanıcı geneli) veya
proje içinde `.claude/skills/jev-decide` olarak kopyala/bağla.

**Hook (risk kapısı):** `settings.json`'a:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node <REPO>/hooks/risk-gate.js" }]
      }
    ]
  }
}
```

Hook env'i devralır; `JEV_API`'yi harness'in başlattığı süreçte tanımlı olmasına dikkat et
(mock ile deneme: `JEV_MOCK=1`).

## ZCode

ZCode, Claude Code ile aynı sözleşmeleri kullanır:

- **MCP:** ayarlarında `mcpServers`'a ekle: `{"jev":{"command":"node","args":["<REPO>/mcp/server.js"]}}`
- **Skill:** `skills/jev-decide/` → `~/.zcode/skills/jev-decide`
- **Hook:** Claude Code ile aynı `PreToolUse` kaydı (settings/hooks bölümü).

## Codex

Codex CLI hook noktası desteklemez → **risk kapısı Codex'te çalışmaz**; fail-open by design:
davranış Jev'siz olur, Codex'in kendi onay politikası geçerlidir. MCP + skill kullanılabilir.

**MCP:** `~/.codex/config.toml`:

```toml
[mcp_servers.jev]
command = "node"
args = ["<REPO>/mcp/server.js"]

[mcp_servers.jev.env]
JEV_API = "<anahtar>"
```

**Skill karşılığı:** Codex skill dizini kullanmaz; `AGENTS.md`'ye şunu ekle:

```markdown
- Toplu tipli kararlar (filtrele/sırala/sınıflandır/eşikle) için `jev` MCP server'ının
  `decide` aracını kullan. Kurallar: <REPO>/skills/jev-decide/SKILL.md
```

## Rollout: off → shadow → active (risk kapısı)

`docs/thresholds.yaml` → `routes.hook.risk_gate.mode`:

1. **shadow** (öntanımlı): her şey çalışır, telemetriye `verdict` (=would) yazılır, akışa sıfır etki.
2. **active** geçiş kriteri (DESIGN.md §5.3): `min_shadow_decisions` (50) gölge karar;
   `would`↔sonuç uyuşmazlığı ≤ `max_mismatch_rate` (%5); destructive yanlış-negatif sıfır.
   Kontrol: `.jev/telemetry.jsonl` içinde `mode=shadow` satırlarını say,
   `hooks` route kararlarını `verdict` alanından karşılaştır.
3. **off**: hook kaydı kaldırılır / `mode: off`.

## Doğrulama

```bash
npm test                 # tam paket (mock, gerçek API gerekmez)
JEV_MOCK=1 node mcp/server.js   # stdio'da elle MCP el sıkışması

# Risk kapısı dağıtımda SHADOW modda: sessiz geçer (akışa sıfır etki), karar telemetriye yazılır.
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/x"},"cwd":"."}' \
  | JEV_MOCK=1 JEV_MOCK_FORCE='{"q_class":{"value":"destructive","confidence":0.93},"q_conf":{"value":"no"}}' \
    node hooks/risk-gate.js
cat .jev/telemetry.jsonl   # → "verdict":"ask","mode":"shadow" satırı

# ACTIVE mod davranışını görmek için: docs/thresholds.yaml kopyasında hook.risk_gate
# route'unu mode: active yapıp JEV_THRESHOLDS ile verin — aynı girdi bu kez
# {"hookSpecificOutput":{"permissionDecision":"ask",...}} JSON'ı basar.
```

Gerçek API sağlığı: server açılışında `GET /v1/models` yoklanır; hata stderr'e yazılır,
server yine de ayağa kalkar (fail-open).
