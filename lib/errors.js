// Jev hatası: kod + mesaj + fail-open önerisi (docs/tool-schema.md §3).
// Bu hataların hiçbiri agent akışını durdurmaz; çağıran route eşiklerine göre passthrough/escalate türetir.
export class JevError extends Error {
  constructor(code, message, { retryable = false, status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.status !== null ? { status: this.status } : {}),
    };
  }
}

// Her hatanın meta'sında taşınan öneri: karar katmanı davranışı asla kötüleştirmez (DESIGN.md §1).
export const VERDICT_SUGGESTION = 'passthrough';
