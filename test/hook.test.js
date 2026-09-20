// PreToolUse risk kapısı — uçtan uca: gerçek süreç spawn edilir, mock Jev zorlanmış
// yanıtlarla (JEV_MOCK_FORCE) §5.2 verdict matrisi ve rollout modları sınanır.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const HOOK = join(PKG_ROOT, 'hooks', 'risk-gate.js');
const realThresholds = readFileSync(join(PKG_ROOT, 'docs', 'thresholds.yaml'), 'utf8');

function thresholdsWith(mode) {
  const idx = realThresholds.indexOf('hook.risk_gate:');
  const at = realThresholds.indexOf('mode: shadow', idx);
  return realThresholds.slice(0, at) + `mode: ${mode}` + realThresholds.slice(at + 'mode: shadow'.length);
}

function runHook({ command, mode = 'active', force = null, tool = 'Bash', mock = true, noKey = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-hook-'));
  const thPath = join(dir, 'thresholds.yaml');
  writeFileSync(thPath, thresholdsWith(mode));
  const env = {
    ...process.env,
    JEV_THRESHOLDS: thPath,
    ...(mock ? { JEV_MOCK: '1' } : {}),
    ...(force ? { JEV_MOCK_FORCE: JSON.stringify(force) } : {}),
  };
  if (noKey) {
    delete env.JEV_MOCK;
    delete env.JEV_API;
    delete env.TYPESAFE_API_KEY;
  }
  const payload = { tool_name: tool, tool_input: { command }, cwd: dir };
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env,
    cwd: dir,
    encoding: 'utf8',
    timeout: 20_000,
  });
  const telemetry = (() => {
    const p = join(dir, '.jev', 'telemetry.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  })();
  return { r, dir, telemetry, stdout: (r.stdout || '').trim() };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('active + destructive 0.93 ≥ 0.85 → ASK kararı (permissionDecision)', () => {
  const { r, dir, stdout, telemetry } = runHook({
    command: 'rm -rf /tmp/jev-test',
    force: { q_class: { value: 'destructive', confidence: 0.93 }, q_conf: { value: 'no' } },
  });
  try {
    assert.equal(r.status, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ASK');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /destructive/);
    assert.equal(telemetry.at(-1).verdict, 'ask');
    assert.equal(telemetry.at(-1).mode, 'active');
  } finally {
    cleanup(dir);
  }
});

test('active + safe 0.95, q_conf=no → note: çıktı yok, akış değişmez', () => {
  const { r, dir, stdout, telemetry } = runHook({
    command: 'npm install left-pad',
    force: { q_class: { value: 'safe', confidence: 0.95 }, q_conf: { value: 'no' } },
  });
  try {
    assert.equal(r.status, 0);
    assert.equal(stdout, '');
    assert.equal(telemetry.at(-1).verdict, 'note');
  } finally {
    cleanup(dir);
  }
});

test('active + safe 0.95 ama q_conf=yes (anlaşmazlık) → passthrough', () => {
  const { r, dir, stdout, telemetry } = runHook({
    command: 'curl https://example.com/api',
    force: { q_class: { value: 'safe', confidence: 0.95 }, q_conf: { value: 'yes' } },
  });
  try {
    assert.equal(r.status, 0);
    assert.equal(stdout, '');
    assert.equal(telemetry.at(-1).verdict, 'passthrough');
  } finally {
    cleanup(dir);
  }
});

test('active + güven floor altı (0.50 < 0.60) → passthrough', () => {
  const { r, dir, stdout } = runHook({
    command: 'docker system prune -a',
    force: { q_class: { value: 'destructive', confidence: 0.5 }, q_conf: { value: 'no' } },
  });
  try {
    assert.equal(r.status, 0);
    assert.equal(stdout, '');
  } finally {
    cleanup(dir);
  }
});

test('shadow + destructive → akışa sıfır etki; telemetriye would değeri (verdict=ask, mode=shadow) yazılır', () => {
  const { r, dir, stdout, telemetry } = runHook({
    command: 'git reset --hard origin/main',
    mode: 'shadow',
    force: { q_class: { value: 'destructive', confidence: 0.93 }, q_conf: { value: 'no' } },
  });
  try {
    assert.equal(r.status, 0);
    assert.equal(stdout, '');
    assert.equal(telemetry.at(-1).mode, 'shadow');
    assert.equal(telemetry.at(-1).verdict, 'ask');
  } finally {
    cleanup(dir);
  }
});

test('statik güvenli: ls → Jeve hiç gitmez, telemetriye tek satır (reason=static_safe)', () => {
  const { r, dir, stdout, telemetry } = runHook({ command: 'ls -la' });
  try {
    assert.equal(r.status, 0);
    assert.equal(stdout, '');
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0].reason, 'static_safe');
    assert.equal(telemetry[0].verdict, 'passthrough');
  } finally {
    cleanup(dir);
  }
});

test('bileşik komut (ls && rm) statik listeye takılmaz — Jev değerlendirir', () => {
  const { r, dir, stdout, telemetry } = runHook({
    command: 'ls -la && rm -rf /',
    force: { q_class: { value: 'destructive', confidence: 0.95 }, q_conf: { value: 'no' } },
  });
  try {
    assert.equal(r.status, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ASK');
    assert.equal(telemetry.at(-1).reason, undefined); // static_safe değil
  } finally {
    cleanup(dir);
  }
});

test('Bash dışı araç (Edit) → hook sessizce geçer, telemetri yok', () => {
  const { r, dir, stdout, telemetry } = runHook({ command: 'x', tool: 'Edit' });
  try {
    assert.equal(r.status, 0);
    assert.equal(stdout, '');
    assert.equal(telemetry.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('anahtar yok/mock kapalı → JEV_E_AUTH → fail-open passthrough, çıkış kodu 0', () => {
  const { r, dir, stdout, telemetry } = runHook({ command: 'rm -rf /tmp/x', noKey: true });
  try {
    assert.equal(r.status, 0);
    assert.equal(stdout, '');
    assert.equal(telemetry.at(-1).error, 'JEV_E_AUTH');
    assert.equal(telemetry.at(-1).verdict, 'passthrough');
  } finally {
    cleanup(dir);
  }
});

test('komut imzası cachei: aynı komut ikinci koşuda cached=true, karar değişmez', () => {
  const first = runHook({
    command: 'git push --force origin main',
    force: { q_class: { value: 'destructive', confidence: 0.95 }, q_conf: { value: 'no' } },
  });
  try {
    assert.ok(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision === 'ASK');
    // Aynı tmp dizinde ikinci koşu: state dir .jev → cwd'de
    const env = {
      ...process.env,
      JEV_MOCK: '1',
      JEV_MOCK_FORCE: JSON.stringify({ q_class: { value: 'safe', confidence: 0.99 }, q_conf: { value: 'no' } }),
      JEV_THRESHOLDS: join(first.dir, 'thresholds.yaml'),
    };
    const payload = { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' }, cwd: first.dir };
    const r2 = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      env,
      cwd: first.dir,
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(r2.status, 0);
    // cache'ten gelen ilk değer (destructive) geçerli — yeni FORCE yok sayılır
    assert.ok(JSON.parse((r2.stdout || '').trim()).hookSpecificOutput.permissionDecision === 'ASK');
    const tel = readFileSync(join(first.dir, '.jev', 'telemetry.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    assert.equal(tel.at(-1).cached, true);
  } finally {
    cleanup(first.dir);
  }
});
