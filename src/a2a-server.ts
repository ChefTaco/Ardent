import express, { type Express, type RequestHandler } from 'express';
import { z } from 'zod';
import { Server as GrpcServer, ServerCredentials } from '@grpc/grpc-js';
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, AgentCard, type AgentInterface } from '@a2a-js/sdk';
import { jsonRpcHandler, restHandler } from '@a2a-js/sdk/server/express';
import { legacyAgentCardRouter } from '@a2a-js/sdk/compat/v0_3/server/express';
import { A2AService, grpcService } from '@a2a-js/sdk/server/grpc';
import type { ArdentConfig } from './config.js';
import { resolveReference } from './config.js';
import { loadPeers, type PeerAuthenticator } from './a2a-peers.js';
import { ArdentA2AExecutor } from './a2a.js';
import { SqliteA2ATaskStore } from './a2a-store.js';
import { SafeA2APushSender, SqliteA2APushStore } from './a2a-push.js';
import { A2APushInbox } from './a2a-push-inbox.js';
import type { ArdentRuntime } from './runtime.js';
import { hermesTeamCard } from './hermes-compat.js';
import { IdempotentA2AHandler } from './a2a-idempotency.js';
import { hermesAlias } from './a2a-hermes-alias.js';
import { ARDENT_VERSION } from './version.js';
import { clientKey, GatedA2AExecutor, jsonRpcTaskCap, limitRequests, PeerTaskGate, restTaskCap, TokenBucketLimiter } from './a2a-rate-limit.js';
import { TeamArtifacts, type ResolvedTeamArtifact } from './team-artifacts.js';
import { pipeline } from 'node:stream/promises';
import { ARTIFACT_TRANSFER_V2_URN, formatReprDigest, parseByteRange } from '@hivemagnus/hive-common/artifact';

/** The transfer-v2 capability this runtime advertises on its Agent Card. */
/** The Agent Card provider: `a2a.provider`, else Ardent itself. */
export const DEFAULT_AGENT_CARD_PROVIDER = { organization: 'Ardent', url: 'https://github.com/ChefTaco/Ardent' } as const;
export function agentCardProvider(config: ArdentConfig): { organization: string; url: string } {
  return config.a2a.provider ?? { ...DEFAULT_AGENT_CARD_PROVIDER };
}

export function artifactTransferExtension(maxBytes: number) {
  return { uri: ARTIFACT_TRANSFER_V2_URN, description: 'Resumable artifact transfer over HTTP Range with SHA-256 verification and renditions',
    required: false, params: { max_bytes: maxBytes, range: true, renditions: true } };
}

/** Publishes the outcome of A2A tasks whose operation execution recovery resumed, held or continued (see `ArdentA2AExecutor.publishRecovered`). */
export type A2ARecoveryPublisher = { /** Resolves once no publication pass is running. */ idle(): Promise<void>; /** Stop listening for settled tasks. */ close(): void };
export type A2ASurface = { app: Express; grpcServer: GrpcServer; card: AgentCard; grpcAddress: string; grpcListenPort: number; pushSender: SafeA2APushSender; pushInbox: A2APushInbox; handler: IdempotentA2AHandler; taskGate: PeerTaskGate;
  recovery: A2ARecoveryPublisher;
  /** Inbound peer authentication; `POST /api/v1/credentials/peers/reload` replaces its credentials. */
  peerAuthenticator: PeerAuthenticator };

/** Refresh only discovery freshness; the reviewed runtime identity and digests stay pinned to this process. */
export function freshHermesTeamCard(source: Awaited<ReturnType<typeof hermesTeamCard>>, now = Date.now()) {
  const team = z.object({ discovery: z.object({ observedAt: z.number().int(), expiresAt: z.number().int() }).passthrough() })
    .passthrough().parse(source.metadata.hermesTeam);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Team-card clock is invalid');
  const observedAt = Math.floor(now / 1000);
  return { ...source, metadata: { hermesTeam: { ...team,
    discovery: { ...team.discovery, observedAt, expiresAt: observedAt + 300 } } } };
}

/** gRPC bypasses Express, so its authenticated calls spend the same per-peer tokens here. */
export function limitedGrpcUser(peer: string | undefined, bucket: TokenBucketLimiter | undefined, onRefuse?: () => void): { isAuthenticated: boolean; userName: string } {
  if (peer && bucket && !bucket.take(peer).allowed) { onRefuse?.(); throw new Error('Too many A2A requests'); }
  return { isAuthenticated: Boolean(peer), userName: peer ?? '' };
}

export async function createA2ASurface(runtime: ArdentRuntime, config: ArdentConfig, env: NodeJS.ProcessEnv = process.env): Promise<A2ASurface> {
  const publicAddress = resolveReference(config.a2a.public_url, env);
  if (!publicAddress) throw new Error('A2A public URL is unconfigured');
  const publicUrl = new URL(publicAddress);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) throw new Error('Invalid A2A public URL');
  const { authenticate, peers, authenticator: peerAuthenticator } = await loadPeers(runtime.profileDir, config, env);
  const teamCard = config.a2a.hermes_compat ? await hermesTeamCard(runtime, config, env) : undefined;
  const grpcPort = Number(publicUrl.port || (publicUrl.protocol === 'https:' ? 443 : 80)) + 1;
  if (grpcPort > 65535) throw new Error('A2A gRPC port is unavailable');
  const listenPort = config.a2a.listen_port ?? Number(publicUrl.port || (publicUrl.protocol === 'https:' ? 443 : 80));
  if (listenPort >= 65535) throw new Error('A2A local gRPC port is unavailable');
  const grpcAddress = `${publicUrl.hostname}:${grpcPort}`;
  const jsonRpcUrl = new URL('/a2a/jsonrpc', publicUrl).href;
  const restUrl = new URL('/a2a/rest', publicUrl).href;
  const interfaces: AgentInterface[] = [];
  for (const binding of config.a2a.bindings) {
    if (binding === 'jsonrpc') interfaces.push({ url: jsonRpcUrl, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' });
    else if (binding === 'http-json') interfaces.push({ url: restUrl, protocolBinding: 'HTTP+JSON', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' });
    else interfaces.push({ url: grpcAddress, protocolBinding: 'GRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' });
  }
  if (config.a2a.bindings.includes('jsonrpc')) interfaces.push({ url: jsonRpcUrl, protocolBinding: 'JSONRPC', protocolVersion: '0.3', tenant: '' });
  const bearerRequirement = [{ schemes: { Bearer: { list: [] } } }];
  const skill = config.a2a.skill ?? { id: 'general-assistance', name: 'General assistance',
    description: 'Answer bounded tasks with the tools this profile enables', tags: ['assistant'], example: 'Summarize the latest update on this topic' };
  const card: AgentCard = {
    name: config.name,
    description: teamCard?.description ?? skill.description,
    supportedInterfaces: interfaces,
    provider: agentCardProvider(config),
    version: ARDENT_VERSION,
    capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: true, extensions: [artifactTransferExtension(config.artifacts.max_bytes)] },
    securitySchemes: { Bearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { description: 'Peer bearer token', scheme: 'bearer', bearerFormat: '' } } } },
    securityRequirements: bearerRequirement,
    defaultInputModes: ['text/plain', 'text/markdown', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [{ id: skill.id, name: skill.name, description: skill.description, tags: [...skill.tags], examples: skill.example ? [skill.example] : [], inputModes: ['text/plain'], outputModes: ['text/plain', 'application/json'], securityRequirements: bearerRequirement }],
    documentationUrl: '', signatures: []
  };
  const pushStore = new SqliteA2APushStore(runtime.store.db, peers);
  const pushSender = new SafeA2APushSender(pushStore, undefined, runtime.logger);
  const pushInbox = new A2APushInbox(runtime.store.db, peers, publicAddress);
  const artifactTransfers = new TeamArtifacts(runtime, config, env);
  const taskStore = new SqliteA2ATaskStore(runtime.store.db);
  const limits = config.a2a.rate_limit;
  const taskGate = new PeerTaskGate(limits.enabled ? limits.max_concurrent_tasks_per_peer : Number.MAX_SAFE_INTEGER);
  const executor = new ArdentA2AExecutor(runtime, env);
  // Interrupted peer tasks have no live request left; publish their outcome once now and after each task settles.
  let recoveryPass: Promise<void> | undefined;
  let again = false;
  let closed = false;
  const publish = (): void => {
    if (closed) return;
    if (recoveryPass) { again = true; return; }
    recoveryPass = executor.publishRecovered(taskStore, pushSender).then(() => undefined, () => undefined)
      .finally(() => { recoveryPass = undefined; if (again) { again = false; publish(); } });
  };
  const unsubscribe = runtime.onTaskSettled(() => publish());
  const recovery: A2ARecoveryPublisher = {
    idle: async () => { while (recoveryPass) await recoveryPass; },
    close: () => { closed = true; unsubscribe(); }
  };
  const handler = new IdempotentA2AHandler(runtime.store.db, taskStore, taskGate, card, taskStore, new GatedA2AExecutor(executor, taskGate), undefined, pushStore, pushSender, async context => {
    const peerId = context.user?.userName;
    if (!context.user?.isAuthenticated || !peerId || !peers.some(peer => peer.id === peerId && peer.enabled)) throw new Error('Authenticated configured peer required');
    return {
      ...card,
      description: `${card.description}. Authenticated peer ${peerId} may submit bounded ${config.profile} tasks.`,
      skills: [...card.skills, { id: `${config.profile}-team-result`, name: 'Validated team result', description: 'Return a mission-bound specialist result for an authenticated team envelope', tags: ['team', config.profile], examples: ['Return a scoped result with evidence'], inputModes: ['text/plain', 'application/json'], outputModes: ['application/json'], securityRequirements: bearerRequirement }]
    };
  });
  const app = express();
  // Off by default: without an explicit proxy list req.ip is the socket address and X-Forwarded-For is ignored.
  if (limits.trusted_proxies.length) app.set('trust proxy', limits.trusted_proxies);
  const pass: RequestHandler = (_req, _res, next) => next();
  const peerOf = (res: express.Response) => String(res.locals.peer);
  const peerBucket = new TokenBucketLimiter({ perMinute: limits.peer_requests_per_minute, burst: limits.peer_burst });
  // Refusals are counted for GET /api/v1/metrics (ardent_a2a_rate_limited_total).
  const refused = (scope: 'ip' | 'peer' | 'tasks') => () => runtime.counters.increment('a2a_rate_limited', { scope });
  const peerLimit = limits.enabled ? limitRequests(peerBucket, (_req, res) => peerOf(res), refused('peer')) : pass;
  const requirePeer = (message: string): RequestHandler => (req, res, next) => {
    const peer = authenticate(req.header('Authorization'));
    if (!peer) { res.status(401).json({ error: message }); return; }
    res.locals.peer = peer;
    next();
  };
  // First in the chain: every route below, authenticated or not, is limited by client address.
  if (limits.enabled) app.use(limitRequests(new TokenBucketLimiter({ perMinute: limits.ip_requests_per_minute, burst: limits.ip_burst }), req => clientKey(req.ip), refused('ip')));
  const unavailable = (status: number) => ({ error: status === 410 ? 'Artifact export revoked or expired' : 'Artifact unavailable' });
  /** Resolve the export for the authenticated peer, or answer the refusal. */
  const exportFor = async (req: express.Request, res: express.Response): Promise<ResolvedTeamArtifact | undefined> => {
    try {
      const result = await artifactTransfers.resolve(peerOf(res), String(req.params.id ?? ''), String(req.query.context ?? ''));
      if (result.status === 200) return result;
      res.status(result.status).json(unavailable(result.status));
    } catch {
      res.status(503).json({ error: 'Artifact export state is unavailable' });
    }
    return undefined;
  };
  // Content of one export. Without Range (or with a stale If-Range) this is the
  // v1 full response, verified as it streams; Range answers 206 or 416.
  app.get('/team/artifacts/:id', requirePeer('Authenticated A2A peer required'), peerLimit, async (req, res) => {
    const resolved = await exportFor(req, res);
    if (!resolved) return;
    const manifest = resolved.manifest;
    const etag = `"${manifest.sha256}"`;
    const ifRange = req.header('If-Range');
    const range = parseByteRange(ifRange === undefined || ifRange === etag ? req.header('Range') : undefined, manifest.size);
    const common = { 'Accept-Ranges': 'bytes', ETag: etag, 'Repr-Digest': formatReprDigest(manifest.sha256), 'X-Content-SHA256': manifest.sha256,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' };
    if (range === null) {
      res.status(416).set({ ...common, 'Content-Range': `bytes */${manifest.size}` }).json({ error: 'Requested range is not satisfiable' });
      return;
    }
    let read;
    try { read = await runtime.artifacts.openRead(manifest.sha256, range ?? {}, { verify: !range }); }
    catch { res.status(409).json(unavailable(409)); return; }
    res.status(range ? 206 : 200).set({ ...common, 'Content-Type': manifest.mime, 'Content-Length': String(read.end - read.start + 1),
      ...(range ? { 'Content-Range': `bytes ${read.start}-${read.end}/${manifest.size}` } : {}),
      'Content-Disposition': `attachment; filename="${manifest.name}"`,
      'X-Artifact-Name': encodeURIComponent(manifest.name), 'X-Hermes-Task-Id': manifest.provenance.producer_task_id,
      ...(resolved.manifest_1_0 ? { 'X-Hermes-Artifact-Manifest': Buffer.from(JSON.stringify(resolved.manifest_1_0)).toString('base64url') } : {}) });
    // A digest failure mid-stream ends the connection before the final chunk.
    await pipeline(read.stream, res).catch(() => { if (!res.destroyed) res.destroy(); });
  });
  app.get('/team/artifacts/:id/manifest', requirePeer('Authenticated A2A peer required'), peerLimit, async (req, res) => {
    const resolved = await exportFor(req, res);
    if (resolved) res.set('Cache-Control', 'private, no-store').json({ manifest: resolved.manifest });
  });
  app.get('/team/artifacts/:id/renditions', requirePeer('Authenticated A2A peer required'), peerLimit, async (req, res) => {
    const resolved = await exportFor(req, res);
    if (!resolved) return;
    try { res.set('Cache-Control', 'private, no-store').json({ renditions: await artifactTransfers.renditions(resolved) }); }
    catch { res.status(503).json({ error: 'Artifact export state is unavailable' }); }
  });
  const pushToken: RequestHandler = (req, res, next) => {
    const peerId = String(req.params.peerId ?? '');
    try { pushInbox.authorize(peerId, req.header('X-A2A-Notification-Token')); }
    catch { res.status(401).json({ error: 'A2A push is unauthorized' }); return; }
    res.locals.peer = `push:${peerId}`;
    next();
  };
  // The token is checked before up to 2 MB of JSON is parsed.
  app.post('/a2a/push/:peerId', pushToken, peerLimit, express.json({ limit: '2mb', type: ['application/json', 'application/a2a+json'] }), (req, res) => {
    try {
      const result = pushInbox.accept(String(req.params.peerId ?? ''), req.header('X-A2A-Notification-Token'), req.body as unknown);
      res.status(202).json({ accepted: true, duplicate: result.duplicate });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Invalid A2A push';
      res.status(/unauthorized/i.test(message) ? 401 : /exceeds/i.test(message) ? 413 : 400).json({ error: message.slice(0, 200) });
    }
  });
  // Serve the explicit v0.3 compatibility card only for legacy-version
  // discovery. The SDK's v1 Express card helper stringifies internal oneofs,
  // so the canonical v1 card goes through the generated protobuf JSON codec.
  app.get(`/${AGENT_CARD_PATH}`, (req, res, next) => {
    if (req.header('A2A-Version')?.startsWith('0.3')) { next(); return; }
    const encoded: unknown = AgentCard.toJSON(card);
    if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded)) throw new Error('A2A Agent Card encoding failed');
    res.json(encoded);
  });
  app.use(`/${AGENT_CARD_PATH}`, legacyAgentCardRouter({ agentCardProvider: handler }));
  if (teamCard) app.get('/.well-known/hermes-team-card.json', requirePeer('Authenticated configured peer required'), peerLimit, (_req, res) => {
    const encoded: unknown = AgentCard.toJSON(card);
    if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded)) throw new Error('A2A Agent Card encoding failed');
    res.set('Cache-Control', 'private, no-store').json({ ...encoded, ...freshHermesTeamCard(teamCard) });
  });
  const auth = requirePeer('Authenticated A2A peer required');
  const jsonRpcCap = jsonRpcTaskCap(taskGate, peerOf, refused('tasks'));
  const userBuilder = async (req: express.Request) => {
    const id = authenticate(req.header('Authorization'));
    return { isAuthenticated: Boolean(id), userName: id ?? '' };
  };
  const aliases: RequestHandler = config.a2a.hermes_compat ? hermesAlias : (_req, _res, next) => next();
  if (config.a2a.bindings.includes('jsonrpc')) app.use('/a2a/jsonrpc', auth, peerLimit, express.json({ limit: '1mb' }), aliases, jsonRpcCap, jsonRpcHandler({ requestHandler: handler, userBuilder, legacyCompat: { enabled: true } }));
  if (config.a2a.bindings.includes('http-json')) app.use('/a2a/rest', auth, peerLimit, restTaskCap(taskGate, peerOf, refused('tasks')), restHandler({ requestHandler: handler, userBuilder }));
  // Hermes Agent's team router posts to the peer origin itself. Keep that
  // optional compatibility route separate from the advertised v1 interface.
  if (config.a2a.hermes_compat && config.a2a.bindings.includes('jsonrpc')) {
    const rootCompat = express.Router();
    rootCompat.use((req, _res, next) => { if (!req.header('A2A-Version')) req.headers['a2a-version'] = '1.0'; next(); });
    rootCompat.use(auth, peerLimit, express.json({ limit: '1mb' }), hermesAlias, jsonRpcCap, jsonRpcHandler({ requestHandler: handler, userBuilder, legacyCompat: { enabled: true } }));
    app.use('/', (req, res, next) => req.path === '/' ? rootCompat(req, res, next) : next());
  }
  const grpcServer = new GrpcServer();
  if (config.a2a.bindings.includes('grpc')) grpcServer.addService(A2AService, grpcService({ requestHandler: handler, userBuilder: async call => {
    const raw = call.metadata.get('authorization')[0];
    return limitedGrpcUser(authenticate(typeof raw === 'string' ? raw : undefined), limits.enabled ? peerBucket : undefined, refused('peer'));
  } }));
  publish();
  return { app, grpcServer, card, grpcAddress, grpcListenPort: listenPort + 1, pushSender, pushInbox, handler, taskGate, recovery, peerAuthenticator };
}

export async function startA2AGrpc(surface: A2ASurface, host = '127.0.0.1'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    surface.grpcServer.bindAsync(`${host}:${surface.grpcListenPort}`, ServerCredentials.createInsecure(), error => error ? reject(error) : resolve());
  });
}
