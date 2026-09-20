# jev.decide — Jev (TypeSafe.ai) Decision Layer for ZCode, Claude Code & Codex

This repository integrates the **Jev** "System One" model from
[TypeSafe.ai](https://docs.typesafe.ai/introduction) into coding agents as a
**MCP server + skill + PreToolUse hook** trio. It is harness-agnostic: the same core
works with **ZCode**, **Claude Code**, and **Codex** (installation per harness below).

## What it does

Let the LLM agent (ZCode / Claude Code / Codex) do open-ended work; delegate the
in-between, repetitive decisions — **filter / rank / classify / threshold** — to Jev:
typed value + probability + calibrated confidence, batched in a single call (fan-out),
with a fail-open guarantee.

- **MCP server** (`jev`): exposes the `decide` tool — a `POST /v1/systemone` wrapper with
  batch fan-out, retry, content-hash caching, and telemetry. In ZCode and Claude Code it
  appears as `mcp__jev__decide`; in Codex as the `jev` server's `decide` tool.
- **Skill** (`skills/jev-decide/SKILL.md`): the rule layer — when to use Jev, when not to,
  question discipline, threshold interpretation. Works as a skill in ZCode and Claude Code;
  in Codex, reference it from `AGENTS.md`.
- **PreToolUse hook** (`hooks/risk-gate.js`): a risk gate for Bash commands with
  `off → shadow → active` rollout. Supported by the ZCode and Claude Code hook contracts;
  Codex has no PreToolUse hook, so the gate is simply absent there — fail-open by design
  (Codex's own approval policy applies).

| Component | Role | Detail |
|---|---|---|
| MCP server (`jev`) | `decide` tool — `POST /v1/systemone` wrapper, batching, retry, cache, telemetry | [docs/tool-schema.md](docs/tool-schema.md) |
| SKILL.md | Rule layer — when to use / not use, question discipline, threshold reading | [DESIGN.md](DESIGN.md) §4 |
| PreToolUse hook | Risk gate — destructive-command detection, `off → shadow → active` rollout | [DESIGN.md](DESIGN.md) §5 |
| Telemetry + calibration | Per-decision class, confidence, and outcome logging; threshold-tuning loop | [DESIGN.md](DESIGN.md) §6 |

## Quick start

```bash
npm test                                  # 98 tests, mock-based — no API key needed
JEV_MOCK=1 node mcp/server.js             # run the MCP server over stdio (mock mode)

# Risk-gate smoke test. NOTE: the shipped route is in *shadow* mode, so the hook stays
# silent by design — the verdict lands in .jev/telemetry.jsonl instead:
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/x"},"cwd":"."}' \
  | JEV_MOCK=1 JEV_MOCK_FORCE='{"q_class":{"value":"destructive","confidence":0.93},"q_conf":{"value":"no"}}' \
    node hooks/risk-gate.js
cat .jev/telemetry.jsonl                  # → verdict:"ask", mode:"shadow"
```

For real usage, set the `JEV_API` environment variable to your TypeSafe.ai API key.
While on the waitlist (or offline), develop against `JEV_MOCK=1` deterministic fake
responses with injectable latency and per-question overrides (`JEV_MOCK_FORCE`).

## Installation (per harness)

Full instructions — including hook registration, rollout criteria, and verification
steps — live in [docs/install.md](docs/install.md). Summary:

| | ZCode | Claude Code | Codex |
|---|---|---|---|
| MCP server | `mcpServers` config → `node <repo>/mcp/server.js` | `claude mcp add jev -- node <repo>/mcp/server.js` (or the repo's `.mcp.json`) | `~/.codex/config.toml` → `[mcp_servers.jev]` |
| Skill | copy `skills/jev-decide/` into the skills directory | copy to `~/.claude/skills/` or `.claude/skills/` | reference `SKILL.md` from `AGENTS.md` |
| Risk gate hook | PreToolUse settings entry | `settings.json` hooks with `Bash` matcher | not supported (fail-open by design) |

### Environment variables (all harnesses)

| Variable | Meaning |
|---|---|
| `JEV_API` | TypeSafe.ai API key (**preferred**; `TYPESAFE_API_KEY` accepted as fallback) |
| `JEV_MOCK` | `1` → deterministic fake responses instead of HTTP (no key needed) |
| `JEV_MOCK_FORCE` | Per-question mock override, e.g. `{"q_class":{"value":"destructive","confidence":0.93}}` |
| `JEV_BASE_URL` | Override `https://api.typesafe.ai` (local proxy / tests) |
| `JEV_THRESHOLDS` | Override the `thresholds.yaml` path (default: `docs/thresholds.yaml` in this repo) |
| `JEV_STATE_DIR` | Relocate the `.jev/` runtime state directory (telemetry, calibration, cache) |

Runtime state lives under `.jev/` (relative to the working directory): `telemetry.jsonl`,
`calibration.jsonl`, `cache.json` — never state or question text, only identifiers and
answer summaries. Keep it out of version control (already in `.gitignore`).

## Repository layout

```
jev.decide/
  README.md               — this file
  DESIGN.md               — architecture and design decisions
  docs/
    tool-schema.md        — the jev.decide MCP tool contract (input/output/errors)
    thresholds.yaml       — ALL thresholds and modes (single reviewable source)
    use-cases.md          — concrete scenarios and question packs
    install.md            — installation for ZCode / Claude Code / Codex + rollout
  lib/                    — core (zero npm dependencies, Node ≥ 18.17)
    yaml-mini.js          — minimal YAML parser (the thresholds + questions subset)
    thresholds.js         — threshold/mode loader (JEV_THRESHOLDS override)
    validate.js           — input schema validation (rejected locally, never hits HTTP)
    cache.js              — content-hash + command-signature cache (TTL, file persistence)
    telemetry.js          — .jev/telemetry.jsonl + calibration.jsonl
    client.js             — Jev client: HTTP, retry, error mapping, JEV_MOCK mode,
                            real-API response normalization
    core.js               — shared decision pipeline (validate → cache → Jev → telemetry)
    questions.js          — question-pack loader
  mcp/server.js           — MCP stdio server "jev" (tool: decide)
  hooks/risk-gate.js      — PreToolUse risk gate (off→shadow→active, escalate-only)
  skills/jev-decide/SKILL.md — the rule layer (when/how to call Jev)
  questions/*.yaml        — hand-reviewed question packs (verbatim from use-cases.md)
  test/                   — node:test suite (98 tests; mock-based)
```

## Core principles (from the research pass)

1. **Fail-open.** If Jev is unreachable or errors, the system falls back to Jev-less
   behavior. The decision layer is removable and never makes behavior worse.
2. **It never invents the option set.** Options, thresholds, and weights are defined by
   code/config; Jev only produces typed judgments among the given options.
3. **Questions and thresholds live in one place.** `thresholds.yaml` + the question packs
   in `questions/`. "Agents are bad at writing questions" (the official skill's own
   warning) — questions are hand-reviewed.
4. **Confidence is the second axis.** Decision = answer × confidence × action risk →
   `act / confirm / escalate`.
5. **No arithmetic, dates, or counting for Jev.** Field extraction is Jev's job,
   computation is code's.
6. **Latency budget:** a single call is 70–500 ms (reported). Only at decision points,
   batched (fan-out) in a single call; never blocking the synchronous critical path.

## Status

**v0.1 implementation complete (2026-09-20), tested:** MCP server (`decide`), PreToolUse
risk gate (`off→shadow→active`, escalate-only), telemetry + calibration, content-hash
cache, question packs, and the skill layer — verified against the real API
(`GET /v1/models` → 200; a real `decide` call returned `destructive` at 0.9 confidence;
the risk gate produced an ASK decision for `rm -rf` via the live API at 0.98 confidence).

The risk gate deliberately ships in **shadow** mode. Promotion to `active` follows the
criteria in DESIGN.md §5.3 (≥50 shadow decisions, ≤5% would-vs-outcome mismatch, zero
destructive false negatives).

## Resources (from the research pass)

- Official: [agent-skill](https://docs.typesafe.ai/agent-skill.md), [patterns](https://docs.typesafe.ai/patterns.md),
  [confidence-routing](https://docs.typesafe.ai/patterns/confidence-routing.md),
  [official skill repo](https://github.com/typesafe-ai/skills)
- Community: [imajin-ai connector](https://github.com/ima-jin/imajin-ai/issues/2197) (service-connector separation, retry),
  [gentle-ai router](https://github.com/Gentleman-Programming/gentle-ai/issues/4779) (confidence-gated, shadow mode),
  [firstmate triage](https://github.com/kunchenguid/firstmate/pull/4896) (fail-open + telemetry),
  [omni-dev best practices](https://github.com/rust-works/omni-dev/issues/1770) (question discipline),
  [isocan](https://github.com/dglazkov/isocan/issues/334) (70–500 ms, auditability principle)
