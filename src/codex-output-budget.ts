/** Codex 0.160 has no native output-token ceiling. This bounds observed agent text. */
export const CODEX_PRODUCTION_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;

export type CodexOutputLimitWitness = {
  kind: 'agent_output_bytes'; threadId: string; turnId: string; itemId: string;
  source: 'delta' | 'completed'; limit: number; observed: number;
};

export class CodexOutputBudget {
  readonly #items = new Map<string, { bytes: number; trailingHighSurrogate: boolean }>();
  #bytes = 0;
  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CODEX_PRODUCTION_OUTPUT_MAX_BYTES)
      throw new Error('CODEX_OUTPUT_BOUND_INVALID');
  }
  observe(threadId: string, turnId: string, itemId: string, text: string, source: 'delta' | 'completed'): CodexOutputLimitWitness | null {
    const key = JSON.stringify([turnId, itemId]);
    const previous = this.#items.get(key);
    // A completed item verifies its deltas without double counting or giving
    // back previously observed bytes. Split surrogate pairs need a correction.
    // Keep counters rather than repeatedly copying or retaining generated text.
    const first = text.charCodeAt(0);
    const joinsSurrogates = source === 'delta' && previous?.trailingHighSurrogate && first >= 0xdc00 && first <= 0xdfff;
    const textBytes = Buffer.byteLength(text, 'utf8');
    const nextBytes = source === 'delta' ? textBytes + (previous?.bytes ?? 0) - (joinsSurrogates ? 2 : 0) : Math.max(previous?.bytes ?? 0, textBytes);
    const bytes = this.#bytes - (previous?.bytes ?? 0) + nextBytes;
    if (bytes > this.maxBytes)
      return { kind: 'agent_output_bytes', threadId, turnId, itemId, source, limit: this.maxBytes, observed: bytes };
    const last = text.charCodeAt(text.length - 1);
    if (nextBytes || previous) this.#items.set(key, { bytes: nextBytes, trailingHighSurrogate: text.length ? last >= 0xd800 && last <= 0xdbff : source === 'delta' && Boolean(previous?.trailingHighSurrogate) });
    this.#bytes = bytes;
    return null;
  }
}
