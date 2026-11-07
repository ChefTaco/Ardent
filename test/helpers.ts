import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { initProfile } from '../src/config.js';

/**
 * Initialize a profile from the bundled template with the optional research
 * tools and A2A surface switched on, as most integration tests exercise them.
 * Tests replace the example endpoints with loopback fixtures.
 */
export async function initTestProfile(dir: string, options: Parameters<typeof initProfile>[1] = {}): Promise<void> {
  await initProfile(dir, options);
  const path = join(dir, 'config.yaml');
  const document = YAML.parseDocument(await readFile(path, 'utf8'));
  document.setIn(['research', 'enabled'], true);
  document.setIn(['research', 'searxng_url'], 'https://search.example.com/');
  document.setIn(['research', 'firecrawl_url'], 'https://extract.example.com/');
  document.setIn(['a2a', 'enabled'], true);
  document.setIn(['a2a', 'listen_port'], 9900);
  document.setIn(['a2a', 'bindings'], ['jsonrpc', 'http-json', 'grpc']);
  await writeFile(path, String(document), { mode: 0o600 });
}
