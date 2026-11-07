import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ArdentConfig } from './config.js';
import { ARDENT_VERSION } from './version.js';

/** Explicit installer files must be private, local and owned; values never leave the process. */
export async function readProtectedFile(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024)
    throw new Error('Protected runtime file must be an owned private regular file');
  return readFile(path);
}

const Status = z.object({ version: z.literal(ARDENT_VERSION), profile: z.string(),
  backend: z.enum(['llamacpp', 'codex']) });
const Readiness = z.object({ status: z.literal('ready'), problems: z.array(z.string()).length(0) });

async function json(url: URL, headers: Record<string, string>, ca?: Buffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url,
      { headers, ...(ca ? { ca } : {}), timeout: 5000 }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error('Acceptance endpoint refused the request')); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) { response.destroy(); reject(new Error('Acceptance response exceeds its bound')); }
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as unknown); }
          catch { reject(new Error('Acceptance endpoint returned invalid JSON')); }
        });
      });
    request.on('timeout', () => request.destroy(new Error('Acceptance endpoint timed out')));
    request.on('error', reject);
    request.end();
  });
}

/** Read-only check. Provider generation and effectful tools require separate explicit acceptance. */
export async function acceptRuntime(config: ArdentConfig, env: NodeJS.ProcessEnv): Promise<
  { ok: true; version: string; profile: string; backend: string } | { ok: false; version: string; reason: string }
> {
  try {
    const host = config.api.host === '::1' ? '[::1]' : config.api.host;
    const endpoint = new URL(env.ARDENT_ACCEPTANCE_URL ?? `http://${host}:${config.api.port}`);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
        (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))))
      throw new Error('Acceptance requires verified HTTPS or the local loopback management listener');
    const token = env[config.api.token_env];
    if (!token || /[\r\n]/.test(token)) throw new Error('Management authentication is missing');
    const ca = env.ARDENT_ACCEPTANCE_CA_FILE ? await readProtectedFile(env.ARDENT_ACCEPTANCE_CA_FILE) : undefined;
    const status = Status.parse(await json(new URL('/api/v1/status', endpoint), { Authorization: `Bearer ${token}` }, ca));
    if (status.profile !== config.profile || status.backend !== config.execution.backend) throw new Error('Selected profile differs from the running gateway');
    Readiness.parse(await json(new URL('/health/ready', endpoint), {}, ca));
    return { ok: true, version: ARDENT_VERSION, profile: status.profile, backend: status.backend };
  } catch {
    return { ok: false, version: ARDENT_VERSION, reason: 'Runtime authentication, version, profile or dependency readiness did not pass' };
  }
}
