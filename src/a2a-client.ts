import { randomUUID } from 'node:crypto';
import { Role, TaskState, type AgentCard, type ListTasksResponse, type Message, type SendMessageRequest, type SendMessageResult, type StreamResponse, type Task } from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory, type Client } from '@a2a-js/sdk/client';
import { GrpcTransportFactory } from '@a2a-js/sdk/client/grpc';
import { credentials } from '@grpc/grpc-js';
import type { ArdentConfig } from './config.js';
import { loadPeers, outboundTokenEnv } from './a2a-peers.js';
import type { A2APushInbox } from './a2a-push-inbox.js';
import { z } from 'zod';

export async function fetchHermesTeamCard(card: AgentCard, authorization: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const interfaceUrl = card.supportedInterfaces.find(item => item.protocolBinding.toUpperCase() === 'JSONRPC' && item.protocolVersion === '1.0')?.url;
  if (!interfaceUrl) throw new Error('Hermes peer has no JSON-RPC 1.0 interface');
  const url = new URL('/.well-known/hermes-team-card.json', interfaceUrl);
  const response = await fetch(url, { redirect: 'manual', headers: { Authorization: authorization, Accept: 'application/json' }, signal: signal ?? AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Hermes team card HTTP ${response.status}`);
  const encoded = await response.text();
  if (Buffer.byteLength(encoded) > 256_000) throw new Error('Hermes team card exceeds bound');
  const raw: unknown = JSON.parse(encoded);
  return z.record(z.string(), z.unknown()).parse(raw);
}

export class ArdentA2AClient {
  constructor(readonly profileDir: string, readonly config: ArdentConfig, readonly env: NodeJS.ProcessEnv = process.env, readonly pushInbox?: A2APushInbox, readonly preferredTransports: string[] = ['JSONRPC', 'HTTP+JSON', 'GRPC']) {}
  async open(peerId: string): Promise<{ card: AgentCard; client: Client; authorization: string }> {
    const { peers } = await loadPeers(this.profileDir, this.config, this.env);
    const peer = peers.find(item => item.id === peerId && item.enabled);
    if (!peer) throw new Error(`A2A peer is not configured: ${peerId}`);
    const token = this.env[outboundTokenEnv(peer)];
    if (!token) throw new Error(`A2A outbound credential is missing: ${outboundTokenEnv(peer)}`);
    const base = new URL(peer.url);
    const basePort = Number(base.port || (base.protocol === 'https:' ? 443 : 80));
    const allowedPorts = new Set([basePort, ...peer.transport_ports]);
    const sameHost = (url: string, grpc: boolean): boolean => {
      const parsed = new URL(grpc ? `http://${url}` : url);
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
      return parsed.hostname === base.hostname && !parsed.username && !parsed.password && !parsed.hash && allowedPorts.has(port) &&
        (grpc ? Boolean(parsed.port) : (base.protocol !== 'https:' || parsed.protocol === 'https:'));
    };
    const safeFetch: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!sameHost(url.href, false)) throw new Error('A2A peer card redirected to an unconfigured host or port');
      return fetch(input, { ...init, redirect: 'manual', signal: init?.signal ?? AbortSignal.timeout(30000) });
    };
    const resolver = new DefaultAgentCardResolver({ fetchImpl: safeFetch, legacyCompat: { enabled: true } });
    const card = await resolver.resolve(peer.url);
    if (!card.supportedInterfaces.length) throw new Error('A2A peer card has no interfaces');
    for (const iface of card.supportedInterfaces) if (!sameHost(iface.url, iface.protocolBinding.toUpperCase() === 'GRPC')) throw new Error('A2A peer card advertises an unconfigured host');
    const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: resolver,
      transports: [new JsonRpcTransportFactory({ fetchImpl: safeFetch, legacyCompat: { enabled: true } }), new RestTransportFactory({ fetchImpl: safeFetch, legacyCompat: { enabled: true } }), new GrpcTransportFactory({ legacyCompat: { enabled: true }, grpcChannelCredentials: base.protocol === 'https:' ? credentials.createSsl() : credentials.createInsecure() })],
      preferredTransports: this.preferredTransports
    }));
    return { card, client: await factory.createFromAgentCard(card), authorization: `Bearer ${token}` };
  }
  async teamControl(peerId: string, control: { version: '1.0'; action: string; key: string; payload: object }): Promise<Record<string, unknown>> {
    const { card, authorization } = await this.open(peerId);
    const rawCard: unknown = await fetchHermesTeamCard(card, authorization);
    const advertised = z.object({ metadata: z.object({ hermesTeam: z.object({ coordinationProtocolVersions: z.array(z.string()) }).passthrough() }).passthrough() }).passthrough().safeParse(rawCard);
    const metadata = advertised.success ? advertised.data.metadata : undefined;
    if (!metadata?.hermesTeam.coordinationProtocolVersions.includes('1.0'))
      throw new Error('A2A peer does not advertise Hermes coordination 1.0');
    const interfaceUrl = card.supportedInterfaces.find(iface => iface.protocolBinding.toUpperCase() === 'JSONRPC' && iface.protocolVersion === '1.0')?.url;
    if (!interfaceUrl) throw new Error('Hermes coordination peer has no JSON-RPC 1.0 interface');
    const messageId = `ctl-${randomUUID()}`;
    // Hermes's accepted control wire requires one exact text part. The SDK's
    // canonical serializer adds mediaType, so this vendor edge is intentionally
    // encoded separately from ordinary standards-compliant SendMessage calls.
    const wire = { jsonrpc: '2.0', id: messageId, method: 'SendMessage', params: { message: {
      messageId, contextId: messageId, role: 'ROLE_USER', parts: [{ text: 'HERMES_COORDINATION_CONTROL' }],
      metadata: { hermesTeamControl: control }
    }, configuration: { blocking: false } } };
    const response = await fetch(interfaceUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: authorization, 'A2A-Version': '1.0', 'Content-Type': 'application/json' }, body: JSON.stringify(wire) });
    if (!response.ok) throw new Error(`Hermes coordination HTTP ${response.status}`);
    const raw: unknown = await response.json();
    const rpc = z.object({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.unknown().optional(),
      error: z.object({ message: z.string() }).passthrough().optional() }).passthrough().parse(raw);
    if (rpc.id !== messageId) throw new Error('Hermes coordination request ID differs');
    if (rpc.error) throw new Error(`Hermes coordination rejected the control: ${rpc.error.message}`);
    const task = z.object({ artifacts: z.array(z.object({ parts: z.array(z.object({ text: z.string().optional() }).passthrough()) }).passthrough()) }).passthrough()
      .safeParse(rpc.result);
    if (!task.success) throw new Error('Hermes coordination returned no task receipt');
    const texts = task.data.artifacts.flatMap(artifact => artifact.parts.flatMap(part => part.text ? [part.text] : []));
    if (texts.length !== 1) throw new Error('Hermes coordination receipt is missing or ambiguous');
    const receipt: unknown = JSON.parse(texts[0] ?? '');
    const parsed = z.object({ version: z.literal('1.0'), request_digest: z.string().regex(/^[a-f0-9]{64}$/), data: z.record(z.string(), z.unknown()) }).parse(receipt);
    return parsed;
  }
  async send(peerId: string, prompt: string, signal?: AbortSignal, contextId?: string, taskId?: string): Promise<SendMessageResult> {
    return (await this.sendWithReceipt(peerId, prompt, signal, contextId, taskId)).result;
  }
  async getTask(peerId: string, id: string, historyLength?: number): Promise<Task> {
    const { client, authorization } = await this.open(peerId);
    return client.getTask({ tenant: '', id, ...(historyLength === undefined ? {} : { historyLength }) }, { serviceParameters: { Authorization: authorization, 'A2A-Version': '1.0' } });
  }
  async listTasks(peerId: string, pageSize = 50, pageToken = '', contextId = ''): Promise<ListTasksResponse> {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('A2A page size must be 1 to 100');
    const { client, authorization } = await this.open(peerId);
    return client.listTasks({ tenant: '', contextId, status: TaskState.TASK_STATE_UNSPECIFIED, pageSize, pageToken, statusTimestampAfter: undefined }, { serviceParameters: { Authorization: authorization, 'A2A-Version': '1.0' } });
  }
  async cancelTask(peerId: string, id: string): Promise<Task> {
    const { client, authorization } = await this.open(peerId);
    return client.cancelTask({ tenant: '', id, metadata: undefined }, { serviceParameters: { Authorization: authorization, 'A2A-Version': '1.0' } });
  }
  async extendedCard(peerId: string): Promise<AgentCard> {
    const { card, client, authorization } = await this.open(peerId);
    if (!card.capabilities?.extendedAgentCard) throw new Error('A2A peer does not advertise an extended Agent Card');
    return client.getAgentCard({ serviceParameters: { Authorization: authorization, 'A2A-Version': '1.0' } });
  }
  async *subscribe(peerId: string, id: string, signal?: AbortSignal): AsyncGenerator<StreamResponse> {
    const { client, authorization } = await this.open(peerId);
    yield* client.resubscribeTask({ tenant: '', id }, { serviceParameters: { Authorization: authorization, 'A2A-Version': '1.0' }, ...(signal ? { signal } : {}) });
  }
  async *sendStreaming(peerId: string, prompt: string, signal?: AbortSignal): AsyncGenerator<StreamResponse> {
    if (!prompt.trim() || prompt.length > 16000) throw new Error('A2A prompt must be 1 to 16000 characters');
    const { client, authorization } = await this.open(peerId);
    const message: Message = { messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: prompt }, metadata: undefined, filename: '', mediaType: 'text/plain' }], metadata: {}, extensions: [], referenceTaskIds: [] };
    yield* client.sendMessageStream({ tenant: '', message, configuration: undefined, metadata: undefined }, { serviceParameters: { Authorization: authorization, 'A2A-Version': '1.0' }, ...(signal ? { signal } : {}) });
  }
  async sendWithReceipt(peerId: string, prompt: string, signal?: AbortSignal, contextId?: string, taskId?: string): Promise<{ result: SendMessageResult; outboundId?: string }> {
    if (!prompt.trim() || prompt.length > 16000) throw new Error('A2A prompt must be 1 to 16000 characters');
    const { card, client, authorization } = await this.open(peerId);
    const message: Message = { messageId: randomUUID(), contextId: contextId ?? '', taskId: taskId ?? '', role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: prompt }, metadata: undefined, filename: '', mediaType: 'text/plain' }], metadata: {}, extensions: [], referenceTaskIds: [] };
    const registered = this.pushInbox && card.capabilities?.pushNotifications ? this.pushInbox.register(peerId, message.messageId) : undefined;
    const request: SendMessageRequest = { tenant: '', message, configuration: registered ? {
      acceptedOutputModes: ['text/plain', 'application/json'], returnImmediately: false,
      taskPushNotificationConfig: { tenant: '', id: '', taskId: '', url: registered.url, token: registered.token, authentication: undefined }
    } : undefined, metadata: undefined };
    try {
      const result = await client.sendMessage(request, { serviceParameters: { Authorization: authorization, 'A2A-Version': '1.0' }, ...(signal ? { signal } : {}) });
      if (registered) {
        if ('id' in result && typeof result.id === 'string') this.pushInbox?.bind(registered.id, result.id);
        else this.pushInbox?.markFailed(registered.id);
      }
      return { result, ...(registered ? { outboundId: registered.id } : {}) };
    } catch (error: unknown) {
      if (registered) this.pushInbox?.markFailed(registered.id);
      throw error;
    }
  }
}
