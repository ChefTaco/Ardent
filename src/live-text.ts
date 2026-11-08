/**
 * Live reply text for running tasks.
 *
 * Backends report model output as it is generated. That text is not journaled:
 * the task's final answer stays the only authoritative result. This module
 * keeps the visible text of the current model step in memory while a task
 * runs so clients can watch a reply form, and forgets it when the task ends.
 */

/** Visible text in one model step. Structured output (JSON for tools or research) is never shown. */
export type StreamMode = 'pending' | 'plain' | 'structured';

export type PlainTextChunk = {
  /** Model step the text belongs to. A new step starts a new reply segment. */
  step: number;
  /** Text this chunk makes visible; empty while undecided or structured. */
  text: string;
  /** True when this chunk revealed the start of plain text for the step. */
  started: boolean;
};

/**
 * Decides per model step whether output is a plain reply or structured data,
 * from its first non-whitespace character, and passes through only plain text.
 */
export class PlainTextFilter {
  #step = -1;
  #mode: StreamMode = 'pending';
  #text = '';
  get step(): number { return this.#step; }
  get mode(): StreamMode { return this.#mode; }
  /** Visible text of the current step so far. */
  get text(): string { return this.#mode === 'plain' ? this.#text : ''; }
  push(chunk: string, step: number): PlainTextChunk {
    if (step !== this.#step) { this.#step = step; this.#text = ''; this.#mode = 'pending'; }
    if (this.#mode === 'structured') return { step, text: '', started: false };
    if (this.#mode === 'pending') {
      const first = chunk.trimStart()[0];
      if (!first) { this.#text += chunk; return { step, text: '', started: false }; }
      this.#mode = first === '{' || first === '[' ? 'structured' : 'plain';
      if (this.#mode === 'structured') { this.#text = ''; return { step, text: '', started: false }; }
      const text = this.#text + chunk;
      this.#text = text;
      return { step, text, started: true };
    }
    this.#text += chunk;
    return { step, text: chunk, started: false };
  }
}

export type LiveTextUpdate =
  | { kind: 'text'; step: number; text: string }
  | { kind: 'delta'; step: number; text: string }
  | { kind: 'end' };
export type LiveTextListener = (update: LiveTextUpdate) => void;

/** Upper bound on retained live text per task; the final answer is stored separately. */
const MAX_LIVE_CHARS = 256_000;

type Entry = { filter: PlainTextFilter; listeners: Set<LiveTextListener>; chars: number };

export class LiveTextHub {
  readonly #tasks = new Map<string, Entry>();

  /** Record model output for a running task and notify subscribers of any visible text. */
  push(taskId: string, chunk: string, step: number): void {
    let entry = this.#tasks.get(taskId);
    if (!entry) { entry = { filter: new PlainTextFilter(), listeners: new Set(), chars: 0 }; this.#tasks.set(taskId, entry); }
    const previousStep = entry.filter.step;
    const out = entry.filter.push(chunk, step);
    if (!out.text) return;
    if (out.started || step !== previousStep) {
      entry.chars = out.text.length;
      if (entry.chars > MAX_LIVE_CHARS) return;
      this.#emit(entry, { kind: 'text', step, text: out.text });
      return;
    }
    entry.chars += out.text.length;
    if (entry.chars > MAX_LIVE_CHARS) return;
    this.#emit(entry, { kind: 'delta', step, text: out.text });
  }

  /** Visible text of the task's current step, if it is running and has shown any. */
  snapshot(taskId: string): { step: number; text: string } | undefined {
    const entry = this.#tasks.get(taskId);
    if (!entry || !entry.filter.text || entry.chars > MAX_LIVE_CHARS) return undefined;
    return { step: entry.filter.step, text: entry.filter.text };
  }

  /** Receive updates until the task ends or the returned function is called. */
  subscribe(taskId: string, listener: LiveTextListener): () => void {
    let entry = this.#tasks.get(taskId);
    if (!entry) { entry = { filter: new PlainTextFilter(), listeners: new Set(), chars: 0 }; this.#tasks.set(taskId, entry); }
    entry.listeners.add(listener);
    return () => {
      const current = this.#tasks.get(taskId);
      current?.listeners.delete(listener);
      if (current && !current.listeners.size && !current.filter.text && current.filter.step < 0) this.#tasks.delete(taskId);
    };
  }

  /** The task finished: tell subscribers and drop its live text. */
  end(taskId: string): void {
    const entry = this.#tasks.get(taskId);
    if (!entry) return;
    this.#tasks.delete(taskId);
    this.#emit(entry, { kind: 'end' });
  }

  #emit(entry: Entry, update: LiveTextUpdate): void {
    for (const listener of entry.listeners) {
      try { listener(update); } catch { /* A failing subscriber must not affect the task. */ }
    }
  }
}
