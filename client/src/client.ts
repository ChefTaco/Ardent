import type { ExecutionContext } from '@hivemagnus/hive-common/execution';
import { executionHeaders, parseExecutionContext } from '@hivemagnus/hive-common/execution';
import type { RetryPolicy } from '@hivemagnus/hive-common/retry';
import { Connection, type ArdentTransport } from './transport.js';
import { followTask, type FollowOptions } from './follow.js';
import { downloadArtifact, type ArtifactDownload, type DownloadOptions } from './download.js';
import { NotFoundError } from './errors.js';
import { uuidFromKey } from './sha256.js';
import type {
  ArtifactImport, ArtifactImportAccepted, ArtifactImportRequest, ArtifactRecord, ArtifactRecordV2, ArtifactRendition, Lineage, OperationalStatus,
  Recovery, RecoveryAction, Session, SessionContext, SessionMessage, Task, TaskAccepted, TaskAdmission, TaskEvent,
} from './types.js';

export interface ArdentClientOptions {
  /** `direct({ baseUrl, getToken })` or `viaMagnus({ baseUrl, nodeId, profile, getToken })`. */
  readonly transport: ArdentTransport;
  /** Execution context v1 sent with every submission (attribution only; it never grants access). */
  readonly execution?: ExecutionContext;
  /** Aborts every request of this client. */
  readonly signal?: AbortSignal;
  /** Retries of safe requests and reconnects of streams. Default: 3 attempts, 250 ms to 4 s. */
  readonly retryPolicy?: RetryPolicy;
}

export interface CallOptions { readonly signal?: AbortSignal }

export interface SubmitInput {
  readonly prompt: string;
  /**
   * Makes the submission safe to repeat: the same key returns the same task. One is generated
   * when omitted. Magnus accepts only UUID keys, so through Magnus another key is replaced by
   * a stable UUID derived from it.
   */
  readonly idempotencyKey?: string;
  readonly sessionId?: string;
  /** Overrides the client's execution context for this task. */
  readonly execution?: ExecutionContext;
  readonly signal?: AbortSignal;
}

export interface RecoveryDecision {
  readonly action: RecoveryAction;
  /** The pending tool call the decision is about, when the task has more than one. */
  readonly callId?: string;
  /** With `mark_applied`: the tool's result, which must match its output schema. */
  readonly result?: unknown;
  readonly note?: string;
  /** With `retry_with_new_deadline`. */
  readonly deadlineSeconds?: number;
}

export interface FollowTaskOptions extends FollowOptions {}

/** What a profile offers through this transport. */
export interface ArdentCapabilities {
  readonly transport: 'direct' | 'magnus';
  readonly version: string;
  readonly profile: string;
  readonly backend: string;
  /** 2 when the profile serves artifact transfer v2 (Range, renditions, imports), else 1. */
  readonly artifactTransfer: number;
  /** Routes available through this transport. */
  readonly features: {
    readonly recovery: boolean;
    readonly lineage: boolean;
    /** The execution context reaches the profile on submissions. */
    readonly execution: boolean;
    readonly artifactContent: boolean;
    readonly renditions: boolean;
    readonly imports: boolean;
  };
  /** The Magnus installation report, when the transport is Magnus and it could be read. */
  readonly magnus?: { readonly capabilities: Readonly<Record<string, unknown>>; readonly installedVersion: string | undefined };
}

export interface ArdentClient {
  readonly tasks: {
    submit(input: SubmitInput): Promise<TaskAccepted>;
    get(id: string, options?: CallOptions): Promise<Task>;
    list(options?: CallOptions & { readonly limit?: number }): Promise<Task[]>;
    events(id: string, options?: CallOptions & { readonly after?: number }): Promise<TaskEvent[]>;
    cancel(id: string, options?: CallOptions): Promise<Task>;
    pause(id: string, options?: CallOptions): Promise<TaskAdmission>;
    resume(id: string, options?: CallOptions): Promise<TaskAdmission>;
    /** Follow the task's events until it finishes, across the 60 s stream rotation and dropped connections, and return the final task. */
    follow(id: string, options?: FollowTaskOptions): Promise<Task>;
  };
  readonly sessions: {
    list(options?: CallOptions & { readonly context?: SessionContext }): Promise<Session[]>;
    open(key: string, options?: CallOptions & { readonly context?: SessionContext; readonly reset?: boolean }): Promise<Session>;
    messages(id: string, options?: CallOptions): Promise<SessionMessage[]>;
  };
  readonly recovery: {
    /** The recovery status, or null for a task that was never interrupted. */
    get(id: string, options?: CallOptions): Promise<Recovery | null>;
    /** Decide a held task. The work continues as a linked continuation task (`continuation_task_id`). Repeating a decision returns the same outcome. */
    decide(id: string, decision: RecoveryDecision, options?: CallOptions): Promise<Recovery>;
  };
  lineage(id: string, options?: CallOptions): Promise<Lineage>;
  readonly artifacts: {
    list(taskId: string, options?: CallOptions): Promise<ArtifactRecord[]>;
    /** The manifest 1.0 record; `{ v2: true }` returns the 1.1 view with renditions and execution provenance. */
    manifest(sha: string, options?: CallOptions & { readonly v2?: false }): Promise<ArtifactRecord>;
    manifest(sha: string, options: CallOptions & { readonly v2: true }): Promise<ArtifactRecordV2>;
    renditions(sha: string, options?: CallOptions): Promise<ArtifactRendition[]>;
    download(sha: string, options?: DownloadOptions): Promise<ArtifactDownload>;
    import(request: ArtifactImportRequest, options?: CallOptions): Promise<ArtifactImportAccepted>;
    imports(options?: CallOptions & { readonly limit?: number }): Promise<ArtifactImport[]>;
    importStatus(id: string, options?: CallOptions): Promise<ArtifactImport>;
  };
  /** `GET /api/v1/status` of the profile. */
  status(options?: CallOptions): Promise<OperationalStatus>;
  /** What the profile offers through this transport, from its status and (through Magnus) the installation report. */
  capabilities(options?: CallOptions): Promise<ArdentCapabilities>;
}

const segment = (value: string, label: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new NotFoundError('NOT_FOUND', `Invalid ${label}`, { status: 404 });
  return encodeURIComponent(value);
};
const digest = (value: string) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new NotFoundError('NOT_FOUND', 'Invalid artifact digest', { status: 404 });
  return value;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A random UUID; `randomUUID` exists only in secure browser contexts, so fall back to random bytes. */
const randomKey = (): string => {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Create a client for one Ardent profile. */
export function createArdentClient(options: ArdentClientOptions): ArdentClient {
  const connection = new Connection(options.transport, { signal: options.signal, retryPolicy: options.retryPolicy, deadlineMs: options.execution?.deadline_ms });
  const magnus = connection.kind === 'magnus';
  const defaultExecution = options.execution === undefined ? undefined : parseExecutionContext(options.execution);
  const read = <T>(path: string, call: CallOptions | undefined, extra: Omit<Parameters<Connection['read']>[0], 'path'> = {}) =>
    connection.read<T>({ path, ...extra }, call?.signal);

  const tasks: ArdentClient['tasks'] = {
    async submit(input) {
      const key = input.idempotencyKey ?? randomKey();
      const execution = input.execution === undefined ? defaultExecution : parseExecutionContext(input.execution);
      const body = { prompt: input.prompt, idempotency_key: magnus && !UUID.test(key) ? uuidFromKey(key) : key, ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}) };
      return connection.action<TaskAccepted>({ path: 'tasks', body, magnus: { action: 'task-submit', body }, execution, effect: 'idempotent',
        headers: executionHeaders(execution) }, input.signal);
    },
    get: async (id, call) => read<Task>(`tasks/${segment(id, 'task ID')}`, call),
    list: async (call = {}) => (await read<{ tasks: Task[] }>('tasks', call, { query: { limit: call.limit } })).tasks,
    events: async (id, call = {}) => (await read<{ events: TaskEvent[] }>(`tasks/${segment(id, 'task ID')}/events`, call, { query: { after: call.after } })).events,
    cancel: async (id, call) => connection.action<Task>({ path: `tasks/${segment(id, 'task ID')}/cancel`, magnus: { action: 'task-cancel', target: id }, effect: 'idempotent' }, call?.signal),
    pause: async (id, call) => connection.action<TaskAdmission>({ path: `tasks/${segment(id, 'task ID')}/pause`, magnus: { action: 'task-pause', target: id }, effect: 'idempotent' }, call?.signal),
    resume: async (id, call) => connection.action<TaskAdmission>({ path: `tasks/${segment(id, 'task ID')}/resume`, magnus: { action: 'task-resume', target: id }, effect: 'idempotent' }, call?.signal),
    async follow(id, follow = {}) {
      segment(id, 'task ID');
      await followTask(connection, id, follow);
      return tasks.get(id, follow.signal ? { signal: follow.signal } : {});
    },
  };

  const sessions: ArdentClient['sessions'] = {
    list: async (call = {}) => (await read<{ sessions: Session[] }>('sessions', call, { query: { context: call.context } })).sessions,
    async open(key, call = {}) {
      const body = { key, ...(call.reset !== undefined ? { reset: call.reset } : {}), ...(call.context !== undefined ? { context: call.context } : {}) };
      return connection.action<Session>({ path: 'sessions', body, magnus: { action: 'session-open', body }, effect: call.reset ? 'unknown' : 'idempotent' }, call.signal);
    },
    messages: async (id, call) => (await read<{ messages: SessionMessage[] }>(`sessions/${segment(id, 'session ID')}/messages`, call)).messages,
  };

  const recovery: ArdentClient['recovery'] = {
    async get(id, call) {
      try { return await read<Recovery>(`tasks/${segment(id, 'task ID')}/recovery`, call, { gate: 'recovery' }); }
      catch (error: unknown) {
        // Ardent answers 404 both for a missing task and for one that was never interrupted.
        if (!(error instanceof NotFoundError)) throw error;
        const task = await tasks.get(id, call);
        return task.recovery ?? null;
      }
    },
    async decide(id, decision, call) {
      const body = { action: decision.action, ...(decision.callId !== undefined ? { call_id: decision.callId } : {}),
        ...(decision.result !== undefined ? { result: decision.result } : {}), ...(decision.note !== undefined ? { note: decision.note } : {}),
        ...(decision.deadlineSeconds !== undefined ? { deadline_seconds: decision.deadlineSeconds } : {}) };
      return connection.action<Recovery>({ path: `tasks/${segment(id, 'task ID')}/recovery`, body, gate: 'recovery',
        magnus: { action: 'task-recovery', target: id, body }, effect: 'idempotent' }, call?.signal);
    },
  };

  const renditions = async (sha: string, call?: CallOptions) =>
    (await read<{ renditions: ArtifactRendition[] }>(`artifacts/${digest(sha)}/renditions`, call, { gate: 'artifact_transfer' })).renditions;
  function manifest(sha: string, call?: CallOptions & { readonly v2?: false }): Promise<ArtifactRecord>;
  function manifest(sha: string, call: CallOptions & { readonly v2: true }): Promise<ArtifactRecordV2>;
  async function manifest(sha: string, call: CallOptions & { readonly v2?: boolean } = {}): Promise<ArtifactRecord | ArtifactRecordV2> {
    return call.v2 ? read<ArtifactRecordV2>(`artifacts/${digest(sha)}/manifest/v2`, call, { gate: 'artifact_transfer' })
      : read<ArtifactRecord>(`artifacts/${digest(sha)}/manifest`, call);
  }
  const artifacts: ArdentClient['artifacts'] = {
    list: async (taskId, call) => (await read<{ artifacts: ArtifactRecord[] }>(`tasks/${segment(taskId, 'task ID')}/artifacts`, call)).artifacts,
    manifest,
    renditions,
    download: async (sha, download = {}) => downloadArtifact(connection, sha, download, (original, signal) => renditions(original, signal ? { signal } : {})),
    import: (request, call) => connection.action<ArtifactImportAccepted>({ path: 'artifacts/imports', body: request, gate: 'artifact_transfer',
      magnus: { action: 'artifact-import', body: request }, effect: 'unknown' }, call?.signal),
    imports: async (call = {}) => (await read<{ imports: ArtifactImport[] }>('artifacts/imports', call, { gate: 'artifact_transfer', query: { limit: call.limit } })).imports,
    importStatus: async (id, call) => read<ArtifactImport>(`artifacts/imports/${segment(id, 'import ID')}`, call, { gate: 'artifact_transfer' }),
  };

  const status = (call?: CallOptions) => read<OperationalStatus>('status', call);
  return {
    tasks, sessions, recovery, artifacts, status,
    lineage: async (id, call) => read<Lineage>(`tasks/${segment(id, 'task ID')}/lineage`, call, { gate: 'lineage' }),
    async capabilities(call) {
      const current = await status(call);
      const transfer = typeof current.capabilities?.artifact_transfer === 'number' ? current.capabilities.artifact_transfer : 1;
      // Recovery counts came with recovery, lineage and execution ancestry.
      const runtime = { recovery: current.recovery !== undefined, transfer: transfer >= 2 };
      const report = await connection.magnusReport();
      const via = async (gate: 'recovery' | 'lineage' | 'artifact_transfer') => !magnus || await connection.advertises(gate);
      const [recoveryRoute, lineageRoute, transferRoute] = await Promise.all([via('recovery'), via('lineage'), via('artifact_transfer')]);
      return {
        transport: connection.kind, version: current.version, profile: current.profile, backend: current.backend, artifactTransfer: transfer,
        features: {
          recovery: runtime.recovery && recoveryRoute, lineage: runtime.recovery && lineageRoute, execution: runtime.recovery && lineageRoute,
          artifactContent: runtime.transfer && transferRoute, renditions: runtime.transfer && transferRoute, imports: runtime.transfer && transferRoute,
        },
        ...(report?.capabilities ? { magnus: { capabilities: report.capabilities, installedVersion: report.version } } : {}),
      };
    },
  };
}
