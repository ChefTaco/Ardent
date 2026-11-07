import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { ArdentConfig } from './config.js';
import { revision } from './config.js';

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const Peer = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), url: z.string().url(),
  token_env: envName.optional(), inbound_token_env: envName.optional(), outbound_token_env: envName.optional(),
  enabled: z.boolean().default(true), transport_ports: z.array(z.number().int().min(1).max(65535)).default([]),
  callback_ports: z.array(z.number().int().min(1).max(65535)).default([]), allow_private_callbacks: z.boolean().default(false)
}).strict().superRefine((peer, context) => {
  const legacy = Boolean(peer.token_env);
  const directional = Boolean(peer.inbound_token_env && peer.outbound_token_env);
  if (legacy === directional || Boolean(peer.inbound_token_env) !== Boolean(peer.outbound_token_env))
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Use one legacy token_env or both directional token references' });
  if (directional && peer.inbound_token_env === peer.outbound_token_env)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Directional token references must differ' });
});
const Peers = z.object({ schema_version: z.literal(1), peers: z.array(Peer).max(100) }).strict();
export type PeerConfig = z.infer<typeof Peer>;
export function inboundTokenEnv(peer: PeerConfig): string { return peer.inbound_token_env ?? peer.token_env ?? ''; }
export function outboundTokenEnv(peer: PeerConfig): string { return peer.outbound_token_env ?? peer.token_env ?? ''; }

export function parsePeersConfig(text: string): PeerConfig[] {
  const document = YAML.parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid peer YAML: ${document.errors[0]?.message ?? 'unknown error'}`);
  const peers = Peers.parse(document.toJS() as unknown).peers;
  if (new Set(peers.map(peer => peer.id)).size !== peers.length) throw new Error('Duplicate A2A peer ID');
  for (const peer of peers) {
    const url = new URL(peer.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search)
      throw new Error(`Invalid A2A peer URL: ${peer.id}`);
  }
  return peers;
}

export async function readPeersConfig(profileDir: string, config: ArdentConfig): Promise<{ text: string; revision: string }> {
  const text = await readFile(join(profileDir, config.a2a.peers_file), 'utf8');
  parsePeersConfig(text);
  return { text, revision: revision(text) };
}

export async function savePeersConfig(profileDir: string, config: ArdentConfig, text: string, expectedRevision: string): Promise<string> {
  if (Buffer.byteLength(text) > 200_000) throw new Error('Peer configuration exceeds size limit');
  parsePeersConfig(text);
  const lockPath = join(profileDir, '.peers.write.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new Error('Peer configuration edit is already in progress');
    throw error;
  });
  let temporary: string | undefined;
  try {
    const current = await readPeersConfig(profileDir, config);
    if (current.revision !== expectedRevision) throw new Error('Peer configuration revision conflict');
    temporary = join(profileDir, `.peers.${randomUUID()}.tmp`);
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(profileDir, config.a2a.peers_file));
    temporary = undefined;
    return revision(text);
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

export async function listPeers(profileDir: string, config: ArdentConfig): Promise<PeerConfig[]> {
  return parsePeersConfig(await readFile(join(profileDir, config.a2a.peers_file), 'utf8'));
}

export async function loadPeers(profileDir: string, config: ArdentConfig, env: NodeJS.ProcessEnv = process.env): Promise<{ peers: PeerConfig[]; authenticate: (authorization: string | undefined) => string | undefined }> {
  const peers = await listPeers(profileDir, config);
  const seen = new Set<string>();
  const credentials: Array<{ id: string; token: Buffer }> = [];
  for (const peer of peers) {
    if (seen.has(peer.id)) throw new Error(`Duplicate A2A peer id: ${peer.id}`);
    seen.add(peer.id);
    if (!peer.enabled) continue;
    const url = new URL(peer.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`Invalid A2A peer URL: ${peer.id}`);
    const inbound = env[inboundTokenEnv(peer)];
    const outbound = env[outboundTokenEnv(peer)];
    if (!inbound || inbound.length < 16) throw new Error(`A2A inbound credential is missing or too short: ${inboundTokenEnv(peer)}`);
    if (!outbound || outbound.length < 16) throw new Error(`A2A outbound credential is missing or too short: ${outboundTokenEnv(peer)}`);
    if (peer.inbound_token_env && inbound === outbound) throw new Error(`A2A directional credentials must differ: ${peer.id}`);
    if (credentials.some(entry => entry.token.length === Buffer.byteLength(inbound) && timingSafeEqual(entry.token, Buffer.from(inbound))))
      throw new Error(`A2A inbound credential is assigned to multiple peers: ${peer.id}`);
    credentials.push({ id: peer.id, token: Buffer.from(inbound) });
  }
  return { peers, authenticate: authorization => {
    const bearer = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
    if (!bearer) return undefined;
    const candidate = Buffer.from(bearer);
    for (const entry of credentials) if (entry.token.length === candidate.length && timingSafeEqual(entry.token, candidate)) return entry.id;
    return undefined;
  } };
}
