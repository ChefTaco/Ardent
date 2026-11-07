import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { registerNewsTools } from '../src/news.js';
import { ArtifactStore } from '../src/artifacts.js';
import { ToolRegistry } from '../src/tools.js';

it('retains Markdown and the exact structured publication time from one bounded publisher extraction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-publisher-jsonld-'));
  const source = 'https://93.184.216.34/story';
  const markdown = 'A publisher reports a useful community development.';
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ success: true, data: { markdown,
      metadata: { title: 'Community report', sourceURL: source },
      rawHtml: `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle',
        mainEntityOfPage: { '@id': source }, datePublished: '2026-10-22T04:00:00-05:00' })}</script>` } }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
    await initTestProfile(dir, { profile: 'coordinator' });
    const { config } = await loadConfig(dir);
    config.research.firecrawl_url = `http://127.0.0.1:${address.port}`;
    const tools = new ToolRegistry();
    registerNewsTools(tools, config, new ArtifactStore(join(dir, 'artifacts')), {});
    const result = await tools.call('news_article', { url: source, max_chars: 5000 }, 'scheduled', AbortSignal.timeout(3000));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: source, formats: ['markdown', 'rawHtml'], maxAge: 0 });
    expect(result).toMatchObject({ ok: true, value: { url: source, source_url: source, markdown,
      published_at: '2026-10-22T04:00:00-05:00', content_sha256: createHash('sha256').update(markdown).digest('hex') } });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
