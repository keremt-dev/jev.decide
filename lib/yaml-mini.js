// Mini YAML parser — yalnızca bu projede kullanılan alt küte:
//   · girintiye dayalı iç içe map'ler
//   · `- öğe` string listeleri
//   · skalarlar: int, float, bool, null, tırnaklı/çıplak string
//   · tam satır ve satır sonu `#` yorumları
// Amaç sıfır bağımlılık: docs/thresholds.yaml ve questions/*.yaml bu alt kümeye uyar.
// Kullanım dışı özellikler (çok satırlı |, >, çapa, akış {}) açıkça reddedilir.
import { readFileSync } from 'node:fs';

export function parse(text) {
  const lines = [];
  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (raw.startsWith('\t')) {
      throw new SyntaxError(`yaml-mini: satır ${i + 1}: tab girinti desteklenmiyor (boşluk kullan)`);
    }
    const stripped = stripComment(raw, i + 1);
    if (stripped.trim() === '') continue;
    lines.push({ indent: stripped.match(/^ */)[0].length, text: stripped.trim(), line: i + 1 });
  }
  if (lines.length === 0) return {};
  const parsed = parseBlock(lines, 0, lines[0].indent);
  // Tüm satırlar tüketilmeli — sessizce yutulan içerik (ör. "  a: 1\nb: 2") yapı hatasıdır.
  if (parsed.next < lines.length) {
    throw new SyntaxError(
      `yaml-mini: satır ${lines[parsed.next].line}: beklenmedik girinti azalışı / tüketilmemiş içerik`,
    );
  }
  return parsed.value;
}

export function loadFile(path) {
  return parse(readFileSync(path, 'utf8'));
}

// ' #' biçimindeki yorumu keser; tırnak içindeki # korunur.
function stripComment(raw, lineNo) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i);
    }
  }
  if (quote) throw new SyntaxError(`yaml-mini: satır ${lineNo}: kapanmamış tırnak`);
  return raw;
}

// 'key: value' veya 'key:' satırını ilk geçerli iki noktadan böler (tırnak dışı, ':' boşluk/EOL izler).
function splitKey(text, lineNo) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i + 1 === text.length || text[i + 1] === ' ')) {
      let key = text.slice(0, i).trim();
      if (isQuoted(key)) key = key.slice(1, -1);
      return { key, rest: text.slice(i + 1).trim() };
    }
  }
  throw new SyntaxError(`yaml-mini: satır ${lineNo}: 'key:' bekleniyordu: ${JSON.stringify(text)}`);
}

function parseBlock(lines, idx, indent) {
  const first = lines[idx];
  if (first.text === '-' || first.text.startsWith('- ')) return parseList(lines, idx, indent);
  return parseMap(lines, idx, indent);
}

function parseMap(lines, idx, indent) {
  const map = {};
  let i = idx;
  while (i < lines.length && lines[i].indent === indent) {
    if (lines[i].text === '-' || lines[i].text.startsWith('- ')) {
      throw new SyntaxError(`yaml-mini: satır ${lines[i].line}: liste öğesi map bloğuna karıştı`);
    }
    const { key, rest } = splitKey(lines[i].text, lines[i].line);
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new SyntaxError(`yaml-mini: satır ${lines[i].line}: yinelenen anahtar '${key}'`);
    }
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const child = parseBlock(lines, i + 1, lines[i + 1].indent);
        map[key] = child.value;
        i = child.next;
      } else {
        map[key] = null;
        i += 1;
      }
    } else {
      map[key] = parseScalar(rest, lines[i].line);
      i += 1;
    }
  }
  if (i < lines.length && lines[i].indent > indent) {
    throw new SyntaxError(`yaml-mini: satır ${lines[i].line}: skalar değerden sonra girintili blok geldi`);
  }
  return { value: map, next: i };
}

function parseList(lines, idx, indent) {
  const arr = [];
  let i = idx;
  while (
    i < lines.length &&
    lines[i].indent === indent &&
    (lines[i].text === '-' || lines[i].text.startsWith('- '))
  ) {
    const rest = lines[i].text === '-' ? '' : lines[i].text.slice(2).trim();
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const child = parseBlock(lines, i + 1, lines[i + 1].indent);
        arr.push(child.value);
        i = child.next;
      } else {
        arr.push(null);
        i += 1;
      }
    } else {
      arr.push(parseInlineItem(rest, lines[i].line));
      i += 1;
    }
  }
  return { value: arr, next: i };
}

// '- öğe' satırındaki öğe: tırnakla başlıyorsa her zaman skalar; değilse 'key: value' inline map de olabilir.
function parseInlineItem(text, lineNo) {
  if (text.startsWith('"') || text.startsWith("'")) return parseScalar(text, lineNo);
  try {
    const { key, rest } = splitKey(text, lineNo);
    if (rest !== '') return { [key]: parseScalar(rest, lineNo) };
  } catch {
    // iki nokta yok → çıplak skalar
  }
  return parseScalar(text, lineNo);
}

function parseScalar(s, lineNo) {
  if (s.startsWith('|') || s.startsWith('>')) {
    throw new SyntaxError(`yaml-mini: satır ${lineNo}: çok satırlı skalar (| >) desteklenmiyor`);
  }
  if (isQuoted(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if (/[:#]/.test(s) && !isQuoted(s)) {
    throw new SyntaxError(`yaml-mini: satır ${lineNo}: ':' veya '#' içeren değerler tırnaklanmalı: ${JSON.stringify(s)}`);
  }
  return s;
}

function isQuoted(s) {
  return (
    s.length >= 2 &&
    ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))
  );
}
