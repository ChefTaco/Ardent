import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../src/artifacts.js';
import { initProfile, loadConfig } from '../src/config.js';
import { JobDefinitionSchema } from '../src/job-engine.js';
import { BoundedNewsInput, boundedNewsHandler } from '../src/job-news-handlers.js';
import type { ArdentRuntime } from '../src/runtime.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('typed bounded news job', () => {
  it('retries a transient empty morning read before retaining the final partial packet', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ results: [], unresponsive_engines: [['news', 'parsing error']] }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
    const dir = await mkdtemp(join(tmpdir(), 'ardent-empty-news-')); dirs.push(dir);
    await initProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.research.searxng_url = `http://127.0.0.1:${address.port}/`;
    const artifacts = new ArtifactStore(join(dir, 'artifacts'));
    const input = { query: 'US news', purpose: 'morning_briefing', retry_empty: true };
    const job = JobDefinitionSchema.parse({ id: 'morning-news', owner: 'ardent', enabled: true,
      handler: 'news.collect', schedule: { cron: '20 5 * * *', timezone: 'UTC',
        missed_window: 'skip', catch_up_minutes: 0 }, input, delivery: { kind: 'none' },
      policy: { max_attempts: 2, retry_backoff_seconds: 60 } });
    const handler = boundedNewsHandler({ config, artifacts } as ArdentRuntime, {});
    const context = { job, input, window_key: 'empty-news-fixture', scheduled_at: new Date(),
      now: new Date(), signal: AbortSignal.timeout(5000) };
    expect(await handler.run({ ...context, attempt: 1 })).toMatchObject({ state: 'retry', receipt: {
      effect_status: 'none', evidence: { prior_discovery_packet_ids: [expect.any(String)], delivery: 'not_attempted' } } });
    expect(await handler.run({ ...context, attempt: 2 })).toMatchObject({ state: 'completed', receipt: {
      effect_status: 'confirmed', evidence: { status: 'partial', sources: [], unresponsive_engines: 1 } } });
  });
  it('falls back after proved-no-write discovery failure and retains at most five articles across three attempts', async () => {
    const queries: string[] = [];
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.startsWith('/search')) {
        const query = new URL(request.url, 'http://fixture').searchParams.get('q') ?? '';
        queries.push(query);
        if (query === 'primary failed') { response.statusCode = 503; response.end('{}'); return; }
        response.end(JSON.stringify({ results: query === 'secondary empty' ? [] : Array.from({ length: 8 }, (_, index) => ({
          url: `https://93.184.216.34/article-${index}`, title: `Publisher report ${index}`, content: 'Discovery' })),
        unresponsive_engines: [] }));
      } else if (request.url === '/v1/scrape') {
        let body = '';
        request.on('data', chunk => { body += String(chunk); });
        request.on('end', () => {
          const url = (JSON.parse(body) as { url: string }).url;
          response.end(JSON.stringify({ success: true, data: { markdown: 'Retained publisher evidence',
            metadata: { sourceURL: url, title: url, publishedTime: '2026-10-01T09:00:00Z' } } }));
        });
      } else { response.statusCode = 404; response.end('{}'); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
    const dir = await mkdtemp(join(tmpdir(), 'ardent-news-five-')); dirs.push(dir);
    await initProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.research.searxng_url = `http://127.0.0.1:${address.port}/`; config.research.firecrawl_url = config.research.searxng_url;
    const artifacts = new ArtifactStore(join(dir, 'artifacts'));
    const input = { query: 'primary failed', purpose: 'morning_briefing', max_articles: 5,
      fallback_searches: [{ query: 'secondary empty', category: 'news' }, { query: 'third succeeds', category: 'news' }] };
    const job = JobDefinitionSchema.parse({ id: 'morning-news', owner: 'ardent', enabled: true,
      handler: 'news.collect', schedule: { cron: '20 5 * * *', timezone: 'UTC',
        missed_window: 'skip', catch_up_minutes: 0 }, input, delivery: { kind: 'none' },
      policy: { max_attempts: 2, retry_backoff_seconds: 60 } });
    const result = await boundedNewsHandler({ config, artifacts } as ArdentRuntime, {}).run({ job, input,
      window_key: 'five-fixture', scheduled_at: new Date(), now: new Date(), attempt: 1, signal: AbortSignal.timeout(5000) });
    expect(queries).toEqual(['primary failed', 'secondary empty', 'third succeeds']);
    expect(result).toMatchObject({ state: 'completed', receipt: { effect_status: 'confirmed', evidence: {
      status: 'partial', discovery_failures: [{ source_id: 'default', code: 'NEWS_DISCOVERY_FAILED' }],
      coverage: { discovered: 8, extracted: 5 } } } });
    const evidence = result.receipt.evidence as { source_packet_id: string; sources: unknown[] };
    const packet = JSON.parse(Buffer.from(await artifacts.get(evidence.source_packet_id)).toString('utf8')) as { articles: unknown[] };
    expect(evidence.sources).toHaveLength(5); expect(packet.articles).toHaveLength(5);
  });
  it('recovers empty news discovery with bounded general search while retaining engine failures and every query', async () => {
    const searches: string[] = [];
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.startsWith('/search')) {
        const query = new URL(request.url, 'http://fixture').searchParams;
        searches.push(`${query.get('categories')}:${query.get('q')}:${query.get('time_range')}`);
        response.end(JSON.stringify(query.get('categories') === 'news'
          ? { results: [], unresponsive_engines: [['news-engine', 'timeout']] }
          : { results: [{ url: 'https://93.184.216.34/dated', title: 'Dated publisher article', content: 'Discovery',
            publishedDate: '2026-10-01T09:00:00Z' }], unresponsive_engines: [] }));
      } else if (request.url === '/v1/scrape') {
        response.end(JSON.stringify({ success: true, data: { markdown: 'Publisher text', metadata: {
          title: 'Dated publisher article', sourceURL: 'https://93.184.216.34/dated', publishedTime: '2026-10-01T09:00:00Z' } } }));
      } else { response.statusCode = 404; response.end('{}'); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
    const dir = await mkdtemp(join(tmpdir(), 'ardent-news-fallback-')); dirs.push(dir);
    await initProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.research.searxng_url = `http://127.0.0.1:${address.port}/`;
    config.research.firecrawl_url = config.research.searxng_url;
    const artifacts = new ArtifactStore(join(dir, 'artifacts'));
    const input = { query: 'overly conjunctive query', purpose: 'morning_briefing', max_articles: 1,
      fallback_searches: [{ query: 'US news', category: 'general' }, { query: 'unused third search', category: 'news' }] };
    const job = JobDefinitionSchema.parse({ id: 'morning-news', owner: 'ardent', enabled: true,
      handler: 'news.collect', schedule: { cron: '20 5 * * *', timezone: 'UTC',
        missed_window: 'skip', catch_up_minutes: 0 }, input, delivery: { kind: 'none' },
      policy: { max_attempts: 2, retry_backoff_seconds: 60 } });
    const result = await boundedNewsHandler({ config, artifacts } as ArdentRuntime, {}).run({ job, input,
      window_key: 'fallback-fixture', scheduled_at: new Date(), now: new Date(), attempt: 1, signal: AbortSignal.timeout(5000) });
    expect(searches).toEqual(['news:overly conjunctive query:day', 'general:US news:day']);
    expect(result).toMatchObject({ state: 'completed', receipt: { evidence: {
      status: 'partial', sources: [{ publisher_url: 'https://93.184.216.34/dated' }],
      unresponsive_engines: 1, coverage: { discovered: 1, extracted: 1 } } } });
    const evidence = result.receipt.evidence as { source_packet_id: string };
    const packet = JSON.parse(Buffer.from(await artifacts.get(evidence.source_packet_id)).toString('utf8')) as {
      articles: unknown[]; searches: Array<{ query: { q: string }; unresponsive_engines: unknown[] }> };
    expect(packet.articles).toHaveLength(1);
    expect(packet.searches[0]?.unresponsive_engines).toEqual([['news-engine', 'timeout']]);
    expect(packet.searches[1]?.query.q).toBe('US news');
    expect(BoundedNewsInput.safeParse({ ...input, purpose: 'Not A Slug' }).success).toBe(false);
  });
  it('retains extraction, original dates, partial failures and unverified claims without a delivery claim', async () => {
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.startsWith('/search')) {
        response.end(JSON.stringify({ results: [
          { url: 'https://93.184.216.34/blocked', title: 'Blocked', content: 'Discovery only', publishedDate: '2026-09-26T10:00:00Z' },
          { url: 'https://93.184.216.34/dated', title: 'Publisher', content: 'Excerpt', publishedDate: '2026-09-26T11:00:00Z' }
        ], unresponsive_engines: [['fixture-engine', 'timeout']] }));
      } else if (request.url === '/v1/scrape') {
        let body = '';
        request.on('data', chunk => { body += String(chunk); });
        request.on('end', () => {
          const url = (JSON.parse(body) as { url: string }).url;
          if (url.endsWith('/blocked')) { response.statusCode = 503; response.end('{}'); return; }
          response.end(JSON.stringify({ success: true, data: { markdown: '# Dated publisher article', metadata: {
            sourceURL: url, publishedTime: '2026-09-26T11:00:00Z'
          } } }));
        });
      } else { response.statusCode = 404; response.end('{}'); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
    const base = `http://127.0.0.1:${address.port}/`;
    const dir = await mkdtemp(join(tmpdir(), 'ardent-news-job-'));
    dirs.push(dir);
    await initProfile(dir);
    const config = (await loadConfig(dir)).config;
    config.research.searxng_url = base;
    config.research.firecrawl_url = base;
    const handler = boundedNewsHandler({ config, artifacts: new ArtifactStore(join(dir, 'artifacts')) } as ArdentRuntime,
      {});
    const input = { query: 'dated publisher update', category: 'news', time_range: 'day', language: 'en',
      limit: 5, max_articles: 1, purpose: 'daily_scan' };
    const job = JobDefinitionSchema.parse({ id: 'daily-scan', owner: 'ardent', enabled: true,
      handler: 'news.collect', schedule: { cron: '0 5 * * *', timezone: 'UTC',
        missed_window: 'skip', catch_up_minutes: 0 }, input,
      delivery: { kind: 'none' }, policy: { max_attempts: 2, retry_backoff_seconds: 60 } });
    const result = await handler.run({ job, input, window_key: 'fixture', scheduled_at: new Date(),
      now: new Date(), attempt: 1, signal: AbortSignal.timeout(5000) });
    expect(result.state).toBe('completed');
    const evidence = result.receipt.evidence as { status: string; failures: Array<{ url: string }>;
      sources: Array<{ publisher_url: string; published_at: string; claim_verification: string }>;
      delivery: string; unresponsive_engines: number };
    expect(evidence).toMatchObject({ status: 'partial', delivery: 'not_attempted', unresponsive_engines: 1 });
    expect(evidence.failures[0]?.url).toBe('https://93.184.216.34/blocked');
    expect(evidence.sources[0]).toMatchObject({ publisher_url: 'https://93.184.216.34/dated',
      published_at: '2026-09-26T11:00:00Z', claim_verification: 'unverified' });
  });

});
