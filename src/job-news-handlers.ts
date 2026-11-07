import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ArdentRuntime } from './runtime.js';
import type { JobHandler, JobRegistry } from './job-engine.js';
import { registerNewsTools } from './news.js';
import { ToolRegistry } from './tools.js';

const DiscoverySource = z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  query: z.string().trim().min(3).max(300), category: z.enum(['news', 'general']).default('news'),
  time_range: z.enum(['day', 'week', 'month', 'year', 'all']).default('day'), language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default('en'),
  limit: z.number().int().min(1).max(12), max_articles: z.number().int().min(1).max(5),
  allow_hosts: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(8).default([]),
  include_title_terms: z.array(z.string().trim().min(2).max(80)).min(1).max(32).optional() }).strict();

export const BoundedNewsInput = z.object({
  query: z.string().trim().min(3).max(300),
  category: z.enum(['news', 'general']).default('news'),
  time_range: z.enum(['day', 'week', 'month']).default('day'),
  language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default('en'),
  limit: z.number().int().min(1).max(10).default(8),
  max_articles: z.number().int().min(1).max(5).default(3),
  purpose: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).default('news_packet'),
  /** Retry an empty packet after transient read-only failures until the final attempt. */
  retry_empty: z.boolean().default(false),
  fallback_searches: z.array(z.object({ query: z.string().trim().min(3).max(300),
    category: z.enum(['news', 'general']) }).strict()).min(1).max(2).optional(),
  discovery_sources: z.array(DiscoverySource).min(1).max(12).optional(),
  /** Hosts treated as first-party publishers in source provenance. */
  publisher_hosts: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(32).default([])
}).strict().superRefine((value, context) => {
  const discoveryIds = value.discovery_sources?.map(item => item.id) ?? [];
  if (new Set(discoveryIds).size !== discoveryIds.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['discovery_sources'], message: 'Duplicate discovery source' });
});

const Article = z.object({ url: z.string().url(), source_url: z.string().url(), source_id: z.string(),
  title: z.string(), published_at: z.string().nullable(), retrieved_at: z.string(),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/), warning: z.string() }).passthrough();
const Packet = z.object({ status: z.enum(['ok', 'partial', 'empty']),
  articles: z.array(Article).max(5), failures: z.array(z.object({ url: z.string(), error: z.string() })).max(10),
  coverage: z.object({ discovered: z.number().int(), title_prefiltered: z.number().int().optional(),
    extracted: z.number().int() }),
  search: z.object({ retrieved_at: z.string(), unresponsive_engines: z.array(z.unknown()) }).passthrough(),
  artifact: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough() }).passthrough();

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Bounded first-party retrieval. A packet is source evidence, never claim verification or delivery. */
export function boundedNewsHandler(runtime: ArdentRuntime, env: NodeJS.ProcessEnv): JobHandler {
  return { input: BoundedNewsInput, effect: 'external', run: async ({ job, input, signal, attempt }) => {
    if (job.delivery.kind !== 'none') throw new Error('News source packet cannot deliver directly');
    const request = BoundedNewsInput.parse(input);
    const tools = new ToolRegistry();
    registerNewsTools(tools, runtime.config, runtime.artifacts, env);
    const discoverySources = request.discovery_sources ?? [{ id: 'default', query: request.query,
      category: request.category, time_range: request.time_range, language: request.language,
      limit: request.limit, max_articles: request.max_articles, allow_hosts: [] },
    ...(request.fallback_searches ?? []).map((item, index) => ({ id: `fallback_${index + 1}`,
      query: item.query, category: item.category, time_range: request.time_range,
      language: request.language, limit: request.limit, max_articles: request.max_articles, allow_hosts: [] }))];
    const packets: Array<{ source: typeof discoverySources[number]; packet: z.infer<typeof Packet> }> = [];
    const discoveryFailures: Array<{ source_id: string; code: string; message: string }> = [];
    for (const source of discoverySources) {
      if (source.id.startsWith('fallback_') && packets.some(item => item.packet.articles.length > 0)) break;
      const result = await tools.call('news_collect', {
        query: source.query, category: source.category, time_range: source.time_range,
        language: source.language, limit: source.limit, max_articles: source.max_articles,
        ...('include_title_terms' in source && source.include_title_terms
          ? { include_title_terms: source.include_title_terms } : {})
      }, 'scheduled', signal);
      if (!result.ok) {
        if (result.effect === 'unknown') return { state: 'unknown',
          receipt: { effect_status: 'unknown', evidence: { code: result.code,
            message: result.message.slice(0, 200), discovery_source_id: source.id,
            prior_discovery_packet_ids: packets.map(item => item.packet.artifact.id),
            discovery_effect: 'unknown', delivery: 'not_attempted' } } };
        discoveryFailures.push({ source_id: source.id, code: result.code,
          message: result.message.slice(0, 200) });
        continue;
      }
      packets.push({ source, packet: Packet.parse(result.value) });
    }
    if (!packets.length) return { state: 'retry',
      receipt: { effect_status: 'none', evidence: { discovery_failures: discoveryFailures } } };
    const first = packets[0]?.packet ?? null;
    const allowed = (host: string, domains: string[]) => !domains.length ||
      domains.some(domain => host === domain || host.endsWith(`.${domain}`));
    const publisher = (host: string) => request.publisher_hosts
      .some(domain => host === domain || host.endsWith(`.${domain}`));
    const sources = packets.flatMap(({ source, packet }) => packet.articles.filter(article =>
      allowed(new URL(article.url).hostname, source.allow_hosts) &&
      allowed(new URL(article.source_url).hostname, source.allow_hosts)).map(article => ({
      source_id: article.source_id, discovery_source_id: source.id, url: article.url,
      publisher: new URL(article.source_url).hostname, publisher_url: article.source_url,
      published_at: article.published_at, retrieved_at: article.retrieved_at,
      extraction: 'extracted' as const, content_sha256: article.content_sha256,
      reporting_role: 'unknown' as const,
      provenance: publisher(new URL(article.source_url).hostname)
        ? 'publisher-search' as const : 'secondary-reporting' as const,
      claim_verification: 'unverified' as const, title_sha256: hash(article.title) })));
    const failures = packets.flatMap(({ source, packet }) => packet.failures.map(item => ({
      discovery_source_id: source.id, url: item.url, error: item.error.slice(0, 200) }))).slice(0, 10);
    const discoveryPackets = packets.map(({ source, packet }) => ({ source_id: source.id,
      artifact_id: packet.artifact.id, status: packet.status,
      filtered_articles: packet.articles.length - packet.articles.filter(article =>
        allowed(new URL(article.url).hostname, source.allow_hosts) &&
        allowed(new URL(article.source_url).hostname, source.allow_hosts)).length,
      coverage: packet.coverage, unresponsive_engines: packet.search.unresponsive_engines.length }));
    const coverage = { discovered: packets.reduce((sum, item) => sum + item.packet.coverage.discovered, 0),
      extracted: packets.reduce((sum, item) => sum + item.packet.coverage.extracted, 0) };
    const unresponsiveEngines = packets.reduce((sum, item) => sum + item.packet.search.unresponsive_engines.length, 0);
    // A transient, definitely read-only outage must not seal an empty morning
    // packet on the first attempt. Unknown tool effects return above and are
    // never retried. The final attempt still retains the honest partial packet.
    if (request.retry_empty && !sources.length &&
        (unresponsiveEngines || failures.length || discoveryFailures.length) && attempt < job.policy.max_attempts) {
      return { state: 'retry', receipt: { effect_status: 'none', evidence: {
        reason: 'No extracted article after transient read-only retrieval failures',
        prior_discovery_packet_ids: packets.map(item => item.packet.artifact.id),
        discovery_failures: discoveryFailures, failures, unresponsive_engines: unresponsiveEngines,
        coverage, delivery: 'not_attempted' } } };
    }
    const searchedAt = packets.map(item => item.packet.search.retrieved_at).sort().at(-1) ?? null;
    if (!first) throw new Error('News packet is unavailable');
    // Retain every attempted search and its failure detail, including empty
    // discovery. The digest-bound packet must match the combined source receipt.
    const packet = packets.length === 1 ? first : { ...first,
      articles: packets.flatMap(item => item.packet.articles).slice(0, 5),
      discovery_packets: discoveryPackets, discovery_failures: discoveryFailures,
      searches: packets.map(item => ({ source_id: item.source.id, query: item.packet.search.query,
        retrieved_at: item.packet.search.retrieved_at, status: item.packet.search.status,
        unresponsive_engines: item.packet.search.unresponsive_engines })), failures, coverage };
    const artifact = packets.length === 1 ? first.artifact
      : await runtime.artifacts.put('news-source-packet.json', 'application/json', Buffer.from(JSON.stringify(packet)));
    return { state: 'completed', receipt: { effect_status: 'confirmed', evidence: {
      purpose: request.purpose, source_packet_id: artifact.id,
      status: discoveryFailures.length || failures.length || unresponsiveEngines ? 'partial' : sources.length ? 'ok' : 'empty',
      searched_at: searchedAt, sources, failures,
      unresponsive_engines: unresponsiveEngines,
      discovery_packets: discoveryPackets, discovery_failures: discoveryFailures,
      coverage_gaps: sources.length ? [] : ['No retained articles; inspect discovery engine failures and empty search coverage'],
      coverage, delivery: 'not_attempted',
      warning: 'Publisher extraction and search rank do not verify claims or independent reporting.'
    } } };
  } };
}

/** Built-in scheduled job handlers available to every profile. */
export function builtinJobHandlers(runtime: ArdentRuntime, env: NodeJS.ProcessEnv): JobRegistry {
  return { 'news.collect': boundedNewsHandler(runtime, env) };
}

/** Validation-only registry (no runtime) for `ardent jobs definitions validate`. */
export const BUILTIN_JOB_VALIDATION_REGISTRY: JobRegistry = {
  'news.collect': { input: BoundedNewsInput, effect: 'external', run: () => Promise.reject(new Error('Validation-only handler')) }
};
