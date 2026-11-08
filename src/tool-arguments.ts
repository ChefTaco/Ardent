import { createHash } from 'node:crypto';

/**
 * Tool arguments that carry file content. Once a tool has run, the content lives in the artifact
 * store; keeping it in the model history would refill the context window on every later step
 * (a few megabytes of base64 can never fit), and journaling it would put the whole file into
 * every task event stream and event page.
 */
const BULK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  artifact_write: ['text', 'base64'],
  document_render: ['source_markdown'],
};
/** Bulk fields up to this many characters stay as they are. */
export const TOOL_ARGUMENT_INLINE_LIMIT = 8192;

function reference(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('value' in result)) return undefined;
  const value = result.value;
  return value && typeof value === 'object' && 'reference' in value && typeof value.reference === 'string' ? value.reference : undefined;
}

/**
 * The arguments with each large bulk field replaced by a short note naming its size and digest,
 * and the stored artifact when the tool's result names one. Other tools and small values are
 * returned unchanged.
 */
export function compactToolArguments(name: string, args: unknown, result?: unknown): unknown {
  const fields = BULK_FIELDS[name];
  if (!fields || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  const stored = reference(result);
  let changed = false;
  const compacted: Record<string, unknown> = { ...args };
  for (const field of fields) {
    const value = compacted[field];
    if (typeof value !== 'string' || value.length <= TOOL_ARGUMENT_INLINE_LIMIT) continue;
    const digest = createHash('sha256').update(value).digest('hex');
    compacted[field] = `[${value.length} characters omitted, sha256 ${digest}${stored ? `; stored as ${stored}` : ''}]`;
    changed = true;
  }
  return changed ? compacted : args;
}
