/**
 * @hivemagnus/ardent-client: the supported remote client for Ardent profiles, standalone or
 * managed by Magnus. Isomorphic: it uses `fetch` and web streams only, so it runs in Node 24+
 * and in modern browsers.
 */
export { createArdentClient } from './client.js';
export type {
  ArdentCapabilities, ArdentClient, ArdentClientOptions, CallOptions, FollowTaskOptions, RecoveryDecision, SubmitInput,
} from './client.js';
export { direct, viaMagnus } from './transport.js';
export type { ArdentTransport, DirectTransportOptions, FetchLike, MagnusTransportOptions, TokenProvider } from './transport.js';
export type { FollowOptions } from './follow.js';
export type { ArtifactDownload, DownloadOptions, DownloadProgress, ResumeSource } from './download.js';
export {
  ArdentClientError, ConflictError, DigestMismatchError, NotFoundError, TransportError, UnauthorizedError, UnsupportedCapabilityError,
} from './errors.js';
export { Sha256 } from './sha256.js';
export type {
  ArtifactImport, ArtifactImportAccepted, ArtifactImportRequest, ArtifactRecord, ArtifactRecordV2, ArtifactRendition, Lineage,
  OperationalStatus, Recovery, RecoveryAction, RecoveryDecisionBody, Session, SessionContext, SessionMessage, Task, TaskAccepted,
  TaskAdmission, TaskEvent, TaskState, TaskText,
} from './types.js';
export type { paths, operations, components } from './generated.js';
export type { ExecutionContext } from '@hivemagnus/hive-common/execution';
export type { RenditionRequest } from '@hivemagnus/hive-common/artifact';
export type { RetryPolicy } from '@hivemagnus/hive-common/retry';
