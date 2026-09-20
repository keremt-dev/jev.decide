// Girdi şeması doğrulama (docs/tool-schema.md §1) — reddedilen girişler yerel hata üretir, HTTP'ye gitmez.
import { JevError } from './errors.js';

const MODELS = new Set(['jev-latest', 'jev-1.13.0', 'jev-preview']);
const ESCAPE_KEYS = ['other', 'none_of_the_above'];
// Yumuşak uyarı kalıpları — bilinen aritmetik/tarih beklentileri (şema §1 'istemci tarafı doğrulamalar').
const CODE_OP_PATTERNS = [/kaç tane/i, /toplamı/i, /hangi tarih önce/i];
const MAX_STATE_TOKENS = 32000; // ~4 karakter/token tahminiyle

export function validateDecideInput(input) {
  const warnings = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new JevError('JEV_E_BAD_REQUEST', 'decide girdisi bir JSON nesnesi olmalı');
  }
  const { state, questions, route, model, ttl_seconds } = input;

  if (state === undefined) throw new JevError('JEV_E_BAD_REQUEST', "'state' zorunlu");
  if (typeof state !== 'string' && typeof state !== 'object') {
    throw new JevError('JEV_E_BAD_REQUEST', "'state' string | object | array olmalı");
  }
  const stateChars = typeof state === 'string' ? state.length : JSON.stringify(state).length;
  const estTokens = Math.ceil(stateChars / 4);
  if (estTokens > MAX_STATE_TOKENS) {
    throw new JevError(
      'JEV_E_STATE_TOO_LARGE',
      `state ~${estTokens} token (> ${MAX_STATE_TOKENS} hedef) — göndermeden önce filtrele`,
    );
  }

  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new JevError('JEV_E_BAD_REQUEST', "'questions' bir nesne olmalı (soru id → soru)");
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new JevError('JEV_E_BAD_REQUEST', "'questions' en az bir soru içermeli");
  for (const id of ids) validateQuestion(id, questions[id], warnings, ids);

  if (route !== undefined && (typeof route !== 'string' || route.trim() === '')) {
    throw new JevError('JEV_E_BAD_REQUEST', "'route' boş olmayan bir string olmalı");
  }
  if (model !== undefined && !MODELS.has(model)) {
    throw new JevError('JEV_E_BAD_REQUEST', `'model' şunlardan biri olmalı: ${[...MODELS].join(', ')}`);
  }
  if (ttl_seconds !== undefined && (!Number.isInteger(ttl_seconds) || ttl_seconds < 0 || ttl_seconds > 86400)) {
    throw new JevError('JEV_E_BAD_REQUEST', "'ttl_seconds' 0–86400 arası tam sayı olmalı (0 = cache yok)");
  }
  return { warnings };
}

function validateQuestion(id, q, warnings, allIds) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) {
    throw new JevError('JEV_E_BAD_REQUEST', `questions.${id}: soru bir nesne olmalı`);
  }
  const { type, instructions, criteria } = q;
  if (typeof instructions !== 'string' || instructions.trim() === '') {
    throw new JevError('JEV_E_BAD_REQUEST', `questions.${id}.instructions: boş olmayan string zorunlu`);
  }

  if (type === 'choice') {
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw new JevError('JEV_E_BAD_REQUEST', `questions.${id}.criteria: nesne (seçenek → rubrik | null) olmalı`);
    }
    const opts = Object.keys(criteria);
    if (opts.length < 2 || opts.length > 255) {
      throw new JevError(
        'JEV_E_BAD_REQUEST',
        `questions.${id}.criteria: 2–255 seçenek (verilen: ${opts.length}; 255 üstü iki aşamalı score'a bölünmeli)`,
      );
    }
    for (const [opt, rubric] of Object.entries(criteria)) {
      if (rubric !== null && typeof rubric !== 'string') {
        throw new JevError('JEV_E_BAD_REQUEST', `questions.${id}.criteria.${opt}: rubrik string | null olmalı`);
      }
    }
    if (!ESCAPE_KEYS.some((k) => k in criteria)) {
      throw new JevError(
        'JEV_E_NO_ESCAPE',
        `questions.${id}: choice paketinde kaçış seçeneği zorunlu ('other' veya 'none_of_the_above')`,
      );
    }
  } else if (type === 'score') {
    if (!Array.isArray(criteria)) {
      throw new JevError('JEV_E_BAD_REQUEST', `questions.${id}.criteria: düzey listesi (düşükten yükseğe) olmalı`);
    }
    if (criteria.length < 2 || criteria.length > 20) {
      throw new JevError('JEV_E_BAD_REQUEST', `questions.${id}.criteria: 2–20 düzey (verilen: ${criteria.length})`);
    }
    if (criteria.some((c) => typeof c !== 'string' || c.trim() === '')) {
      throw new JevError('JEV_E_BAD_REQUEST', `questions.${id}.criteria: tüm düzeyler boş olmayan string olmalı`);
    }
  } else if (type === 'noul') {
    if (criteria !== undefined) {
      throw new JevError('JEV_E_BAD_REQUEST', `questions.${id}: noul sorusu 'criteria' almaz (yalnızca instructions)`);
    }
  } else {
    throw new JevError(
      'JEV_E_BAD_REQUEST',
      `questions.${id}.type: 'choice' | 'score' | 'noul' olmalı (verilen: ${JSON.stringify(type)})`,
    );
  }

  for (const re of CODE_OP_PATTERNS) {
    if (re.test(instructions)) {
      warnings.push({
        code: 'JEV_W_CODE_OP',
        message: `questions.${id}.instructions aritmetik/tarih beklentisi içeriyor ('${re.source}') — hesap kodda yapılmalı`,
      });
      break;
    }
  }
  for (const other of allIds) {
    if (other !== id && instructions.includes(other)) {
      warnings.push({
        code: 'JEV_W_DEPENDENT',
        message: `questions.${id}.instructions '${other}' sorusuna değiniyor — bağımlı yargılar ayrı çağrılara bölünmeli`,
      });
      break;
    }
  }
}
