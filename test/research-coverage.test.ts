import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';
import { parseResearchBrief, repairObservedResearchFormat, repairResearchArrayStrings } from '../src/research.js';

describe('research evidence coverage', () => {
  it('keeps each article provenance atomic across later discovery and a replacement extraction', async () => {
    const url = 'https://93.184.216.34/atomic-source';
    const id = createHash('sha256').update(url).digest('hex').slice(0, 16);
    const publication = '2026-10-01T11:01:00+00:00';
    let turn = 0;
    let extractions = 0;
    let replace = false;
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.startsWith('/search')) {
        response.end(JSON.stringify({ results: [{ url, title: 'Later discovery title',
          content: 'Discovery excerpt', publishedDate: '2026-10-01T15:00:00Z', engines: ['fixture'] }], unresponsive_engines: [] }));
        return;
      }
      if (request.url === '/v1/scrape') {
        extractions++;
        response.end(JSON.stringify({ success: true, data: {
          markdown: extractions === 1 ? 'Exact original publisher article bytes' : 'Replacement publisher article bytes',
          metadata: { sourceURL: url, title: extractions === 1 ? 'Original publisher title' : 'Replacement publisher title',
            ...(extractions === 1 ? { publishedTime: publication } : {}) }
        } }));
        return;
      }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end('{}'); return; }
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      const input = JSON.parse(body) as { stream: boolean };
      turn++;
      const operations = ['news_article', 'news_search', ...(replace ? ['news_article'] : [])];
      const tool = operations[turn - 1];
      const brief = { question: 'Which source?', scope: 'provenance regression', as_of: new Date().toISOString(),
        findings: ['Publisher evidence retrieved'], claims: [{ text: 'The publisher reports an update', source_ids: [id], qualification: 'Unverified claim' }],
        contrary_evidence: [], coverage_gaps: [], artifact_ids: [], answer_markdown: `2026-10-01 ${url}`,
        source_assessments: [{ source_id: id, reporting_role: 'original', basis: 'Publisher reporting, model assessed' }] };
      const message = tool ? { tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function', function: {
        name: tool, arguments: JSON.stringify(tool === 'news_article' ? { url } : { query: 'followup source' })
      } }] } : { content: JSON.stringify(brief) };
      if (input.stream === false) response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(brief) } }] }));
      else {
        response.setHeader('Content-Type', 'text/event-stream');
        response.end(`data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\ndata: [DONE]\n\n`);
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const dir = await mkdtemp(join(tmpdir(), 'ardent-atomic-source-'));
    let runtime: ArdentRuntime | undefined;
    try {
      await initTestProfile(dir);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const config = (await loadConfig(dir)).config;
      config.providers.llamacpp.base_url = `http://127.0.0.1:${address.port}`;
      config.providers.llamacpp.model = 'fixture';
      config.research.searxng_url = config.providers.llamacpp.base_url;
      config.research.firecrawl_url = config.providers.llamacpp.base_url;
      runtime = new ArdentRuntime(dir, config, {});
      for (replace of [false, true]) {
        turn = 0; extractions = 0;
        const task = runtime.accept('Read publisher, then perform a discovery followup');
        const result = await runtime.run(task.id, {});
        const articles = runtime.store.events(task.id).filter(event => event.kind === 'tool_result')
          .map(event => event.detail as { name: string; result: { value: Record<string, unknown> } })
          .filter(event => event.name === 'news_article').map(event => event.result.value);
        const exact = articles.at(-1)!;
        expect(result.brief?.source_register?.[0]).toMatchObject({ source_id: id, url,
          title: exact.title, evidence_kind: 'extracted_article', published_at: replace ? null : publication,
          retrieved_at: exact.retrieved_at, content_sha256: exact.content_sha256,
          reporting_role: 'original', role_basis: 'Publisher reporting, model assessed' });
        expect(articles).toHaveLength(replace ? 2 : 1);
      }
    } finally {
      runtime?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('repairs exact_url only against the same retrieved source ID and preserves the source assessment', () => {
    const url = 'https://publisher.example/story';
    const sourceId = 'retained-source';
    const raw = { question: 'What happened?', scope: 'positive news', as_of: new Date().toISOString(),
      findings: ['A publisher reported progress.'], claims: [{ text: 'Progress was reported.',
        source_ids: [sourceId], qualification: 'Claim unverified' }], contrary_evidence: [], coverage_gaps: [],
      artifact_ids: [], answer_markdown: url, source_register: [{ source_id: sourceId, exact_url: url,
        evidence_kind: 'extracted_article', reporting_role: 'original', role_basis: 'Reporter interview',
        title: 'Progress', published_at: null, retrieved_at: null, content_sha256: null }] };
    const repair = (value: unknown, sources = new Map([[sourceId, url]])) =>
      repairObservedResearchFormat(JSON.stringify(value), new Set([sourceId]), new Set(), new Set([url]), sources);
    const corrected = repair(raw);
    expect(corrected).not.toBeNull();
    expect(parseResearchBrief(corrected!, new Set([sourceId]), new Set()).source_register)
      .toEqual([{ ...raw.source_register[0], exact_url: undefined, url }].map(({ exact_url: _alias, ...source }) => source));
    expect(repair(raw, new Map([['different-source', url]]))).toBeNull();
    expect(repair({ ...raw, source_register: [{ ...raw.source_register[0], url: 'https://other.example/story' }] })).toBeNull();
    expect(repair({ ...raw, source_register: [{ ...raw.source_register[0], source_id: 'invented-source' }] })).toBeNull();
    expect(repair({ ...raw, candidate_slate: [{ source_id: sourceId, scores: 'malformed' }] })).toBeNull();
    expect(() => parseResearchBrief(JSON.stringify({ ...raw,
      source_register: [{ ...raw.source_register[0], source_id: 'invented-source', url }] }),
    new Set([sourceId]), new Set())).toThrow('Research register cites unknown source');
  });
  it('repairs only a single coverage-gaps string after every other field and citation passes', () => {
    const brief = { question: 'What source?', scope: 'peer read', as_of: new Date().toISOString(),
      findings: ['Official page retrieved.'], claims: [{ text: 'The page exists.', source_ids: ['observed-source'],
        qualification: 'Publisher page only' }], contrary_evidence: [], coverage_gaps: 'Publication date unavailable.',
      artifact_ids: [], answer_markdown: 'The observed page is the only support.' };
    const raw = JSON.stringify(brief);
    expect(() => parseResearchBrief(raw, new Set(['observed-source']), new Set())).toThrow();
    const repaired = repairResearchArrayStrings(raw, new Set(['observed-source']), new Set());
    expect(repaired).not.toBeNull();
    expect(repaired?.fields).toEqual(['coverage_gaps']);
    expect(parseResearchBrief(repaired!.text, new Set(['observed-source']), new Set()).coverage_gaps)
      .toEqual(['Publication date unavailable.']);
    expect(repairResearchArrayStrings(raw, new Set(), new Set())).toBeNull();
    expect(repairResearchArrayStrings(JSON.stringify({ ...brief, coverage_gaps: '' }),
      new Set(['observed-source']), new Set())).toBeNull();
    expect(repairResearchArrayStrings(JSON.stringify({ ...brief, coverage_gaps: ['already valid'] }),
      new Set(['observed-source']), new Set())).toBeNull();
  });
  it('repairs the exact Assistant two-string shape without changing a fact, citation, or mission conclusion', () => {
    const sourceId = 'observed-cisa-source';
    const raw = { question: 'What does the advisory say?', scope: 'Coordinator delegated research', as_of: new Date().toISOString(),
      findings: 'One CISA catalog page was retrieved.',
      claims: [{ text: 'The catalog lists the advisory.', source_ids: [sourceId], qualification: 'Single owner page; no independent confirmation' }],
      contrary_evidence: [], coverage_gaps: 'Only one catalog page was retrieved; exposure is unverified.',
      artifact_ids: [], answer_markdown: 'The catalog page lists the advisory, with exposure unverified.',
      source_assessments: [{ source_id: sourceId, reporting_role: 'original', basis: 'CISA catalog page' }] };
    const repaired = repairResearchArrayStrings(JSON.stringify(raw), new Set([sourceId]), new Set());
    expect(repaired?.fields).toEqual(['findings', 'coverage_gaps']);
    const value = JSON.parse(repaired!.text) as Record<string, unknown>;
    expect(value).toEqual({ ...raw, findings: [raw.findings], coverage_gaps: [raw.coverage_gaps] });
    expect(value).not.toHaveProperty('team_result');
    expect(parseResearchBrief(repaired!.text, new Set([sourceId]), new Set()).claims).toEqual(raw.claims);
    expect(repairResearchArrayStrings(JSON.stringify(raw), new Set(['different-source']), new Set())).toBeNull();
    expect(repairResearchArrayStrings(JSON.stringify({ ...raw, claims: [{ ...raw.claims[0], source_ids: ['invented'] }] }),
      new Set([sourceId]), new Set())).toBeNull();
    expect(repairResearchArrayStrings(JSON.stringify({ ...raw, findings: '' }), new Set([sourceId]), new Set())).toBeNull();
    expect(repairResearchArrayStrings(JSON.stringify({ ...raw, contrary_evidence: 'also malformed' }),
      new Set([sourceId]), new Set())).toBeNull();
  });
  it('normalizes one model finding while retaining exact citation validation', () => {
    const source = 'verified-source';
    const response = JSON.stringify({ question: 'Which report?', scope: 'followup', as_of: new Date().toISOString(), findings: 'One publisher report was retrieved.', claims: [{ text: 'A publisher reported the update.', source_ids: [source], qualification: 'reported' }], contrary_evidence: [], coverage_gaps: [], artifact_ids: [], answer_markdown: 'One report supports the answer.' });
    expect(parseResearchBrief(response, new Set([source]), new Set()).findings).toEqual(['One publisher report was retrieved.']);
    expect(() => parseResearchBrief(response, new Set(), new Set())).toThrow('unknown source');
  });
  it('keeps an observed finding and one team citation when the model formats both as the wrong JSON types', () => {
    const url = 'https://publisher.example/advisory';
    const sourceId = 'observed-source';
    const criterion = 'Return the observed source and its retrieval time';
    const raw = { question: 'Which advisory?', scope: 'read only', as_of: new Date().toISOString(),
      findings: [{ source_url: url, retrieved_at: new Date().toISOString(), publisher_date: 'unverified', event_date: 'unavailable' }],
      claims: [{ text: 'The page reports an advisory.', source_ids: [sourceId], qualification: 'Single publisher' }],
      contrary_evidence: [], coverage_gaps: ['Independent confirmation unavailable'], artifact_ids: [],
      answer_markdown: 'The source reports an advisory.',
      team_result: { version: '1.0', mission_id: 'mission', mission_revision: 1, task_id: 'task', outcome: 'completed',
        summary: 'One observed source', checks: [{ criterion, status: 'pass', evidence: `source:${url}` }],
        artifacts: [], uncertain_effects: [] } };
    const corrected = repairObservedResearchFormat(JSON.stringify(raw), new Set([sourceId]), new Set(), new Set([url]));
    expect(corrected).not.toBeNull();
    const parsed = parseResearchBrief(corrected!, new Set([sourceId]), new Set());
    expect(parsed.findings).toEqual([JSON.stringify(raw.findings[0])]);
    expect(parsed.team_result?.checks[0]?.evidence).toEqual([`source:${url}`]);
    expect(parsed.claims).toEqual(raw.claims);
    expect(repairObservedResearchFormat(JSON.stringify(raw), new Set([sourceId]), new Set(), new Set())).toBeNull();
    expect(repairObservedResearchFormat(JSON.stringify({ ...raw, claims: [{ ...raw.claims[0], source_ids: ['invented'] }] }),
      new Set([sourceId]), new Set(), new Set([url]))).toBeNull();
  });
  it('reports empty, partial, and conflicting retrieval honestly and rejects invented citations', async () => {
    const urls = ['https://93.184.216.34/first', 'https://93.184.216.35/second'];
    const ids = urls.map(url => createHash('sha256').update(url).digest('hex').slice(0, 16));
    let mode: 'empty' | 'partial' | 'conflict' | 'fabricated' = 'empty';
    let modelTurn = 0;
    const server = createServer(async (request, response) => {
      if (request.url?.startsWith('/search')) {
        response.setHeader('Content-Type', 'application/json');
        const results = mode === 'empty' ? [] : urls.slice(0, mode === 'partial' || mode === 'fabricated' ? 1 : 2).map((url, index) => ({ url, title: `Publisher ${index + 1}`, content: index === 0 ? 'The event happened' : 'The event was denied', engines: ['fixture'] }));
        response.end(JSON.stringify({ results, unresponsive_engines: mode === 'partial' ? [['backup', 'timeout']] : [] }));
        return;
      }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end('{}'); return; }
      let body = '';
      for await (const chunk of request) body = (body + chunk.toString()).slice(0, 256_000);
      const input = JSON.parse(body) as { stream: boolean };
      modelTurn++;
      const sourceIds = mode === 'fabricated' ? ['invented-source-id'] : mode === 'conflict' ? ids : mode === 'partial' ? ids.slice(0, 1) : [];
      const brief = {
        question: 'What is known?', scope: mode, as_of: new Date().toISOString(),
        findings: mode === 'empty' ? [] : ['The fixture search returned a report.'],
        claims: sourceIds.map((id, index) => ({ text: index ? 'The second report denies the event' : 'The first report says it happened', source_ids: [id], qualification: 'search snippet only' })),
        contrary_evidence: mode === 'conflict' ? ['The reports disagree on whether the event happened.'] : [],
        coverage_gaps: mode === 'empty' ? ['Search returned no sources'] : mode === 'partial' ? ['One search engine timed out; no article was extracted'] : ['Original articles were not extracted'],
        artifact_ids: [], answer_markdown: mode === 'empty' ? 'No source was retrieved, so no factual claim is supported.' : 'The fixture sources require qualification.',
        ...(mode === 'partial' ? { source_register: [{ source_id: ids[0], exact_url: urls[0],
          evidence_kind: 'extracted_article', reporting_role: 'original', role_basis: 'Publisher reporting, model assessed',
          title: 'Invented model title', published_at: '2026-10-01T00:00:00Z', retrieved_at: '2026-10-01T01:00:00Z',
          content_sha256: 'a'.repeat(64) }] } : {}),
      };
      const delta = modelTurn === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'search-1', type: 'function', function: { name: 'news_search', arguments: '{"query":"fixture evidence"}' } }] } }] }
        : { choices: [{ delta: { content: JSON.stringify(brief) } }] };
      if (input.stream === false) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(brief) } }] }));
      } else {
        response.setHeader('Content-Type', 'text/event-stream');
        response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const dir = await mkdtemp(join(tmpdir(), 'ardent-coverage-'));
    try {
      await initTestProfile(dir);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const endpoint = `http://127.0.0.1:${address.port}`;
      const config = (await loadConfig(dir)).config;
      config.providers.llamacpp.base_url = endpoint;
      config.providers.llamacpp.model = 'fixture';
      config.research.searxng_url = endpoint;
      const runtime = new ArdentRuntime(dir, config, {});
      try {
        for (const scenario of ['empty', 'partial', 'conflict'] as const) {
          mode = scenario; modelTurn = 0;
          const task = runtime.accept('What is known?');
          const result = await runtime.run(task.id, {});
          expect(result.task.state).toBe('completed');
          expect(result.brief?.coverage_gaps.length).toBeGreaterThan(0);
          if (scenario === 'empty') {
            expect(result.brief?.findings).toEqual([]);
            expect(result.brief?.claims).toEqual([]);
            expect(result.brief?.source_register).toEqual([]);
          } else {
            const expected = scenario === 'conflict' ? ids : ids.slice(0, 1);
            expect(result.brief?.source_register?.map(source => source.source_id)).toEqual(expected);
            expect(result.brief?.claims.flatMap(claim => claim.source_ids)).toEqual(expected);
            expect(result.brief?.source_register?.every(source => source.evidence_kind === 'search_snippet')).toBe(true);
            if (scenario === 'partial') {
              expect(result.brief?.source_register?.[0]).toMatchObject({ reporting_role: 'original',
                role_basis: 'Publisher reporting, model assessed', title: 'Publisher 1',
                published_at: null, content_sha256: null });
              expect(runtime.store.events(task.id).some(event => event.kind === 'research_observed_format_repaired')).toBe(true);
            }
            if (scenario === 'conflict') expect(result.brief?.contrary_evidence[0]).toContain('disagree');
          }
        }
        mode = 'fabricated'; modelTurn = 0;
        const fake = runtime.accept('Cite a fabricated source');
        await expect(runtime.run(fake.id, {})).rejects.toThrow('unknown source');
        expect(runtime.store.get(fake.id)?.state).toBe('failed');
        expect(runtime.store.events(fake.id).some(event => event.kind === 'research_repair_attempt')).toBe(true);
      } finally { runtime.close(); }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
