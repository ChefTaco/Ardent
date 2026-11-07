import { describe, expect, it } from 'vitest';
import { CodexOutputBudget, CODEX_PRODUCTION_OUTPUT_MAX_BYTES } from './codex-output-budget.js';

describe('Codex aggregate agent output byte bound', () => {
  it('counts Unicode bytes, including surrogate pairs split across deltas, without double counting completion', () => {
    const budget = new CodexOutputBudget(4);
    expect(budget.observe('thread', 'turn', 'item', '\ud83e', 'delta')).toBeNull();
    expect(budget.observe('thread', 'turn', 'item', '', 'delta')).toBeNull();
    expect(budget.observe('thread', 'turn', 'item', '\udd91', 'delta')).toBeNull();
    expect(budget.observe('thread', 'turn', 'item', '🦑', 'completed')).toBeNull();
    expect(budget.observe('thread', 'turn', 'item', 'a', 'delta')).toMatchObject({ limit: 4, observed: 5, source: 'delta' });
  });
  it('bounds all agent items together, including commentary and completed-only output', () => {
    const budget = new CodexOutputBudget(10);
    expect(budget.observe('thread', 'turn', 'commentary', '12345', 'completed')).toBeNull();
    expect(budget.observe('thread', 'turn', 'final', '67890', 'delta')).toBeNull();
    expect(budget.observe('thread', 'turn', 'final', '67890', 'completed')).toBeNull();
    expect(budget.observe('thread', 'turn', 'last', '海', 'completed')).toEqual({ kind: 'agent_output_bytes', threadId: 'thread', turnId: 'turn', itemId: 'last', source: 'completed', limit: 10, observed: 13 });
  });
  it('separates colliding-looking identities without letting shorter completion regain streamed bytes', () => {
    const budget = new CodexOutputBudget(7);
    expect(budget.observe('thread', 'a:b', 'c', '123', 'delta')).toBeNull();
    expect(budget.observe('thread', 'a:b', 'c', '1', 'completed')).toBeNull();
    expect(budget.observe('thread', 'a', 'b:c', '2345', 'completed')).toBeNull();
    expect(budget.observe('thread', 'a', 'b:c', '6', 'delta')).toMatchObject({ observed: 8 });
  });
  it.each([0, -1, 1.5, NaN, Infinity, CODEX_PRODUCTION_OUTPUT_MAX_BYTES + 1])('rejects invalid configured caps %s', cap => {
    expect(() => new CodexOutputBudget(cap)).toThrow('CODEX_OUTPUT_BOUND_INVALID');
  });
});
