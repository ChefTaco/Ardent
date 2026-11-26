import type { operations } from './generated.js';

type Op = keyof operations;
/** The JSON body an operation answers with `status`, from the generated OpenAPI types. */
type Json<K extends Op, S extends number = 200> = operations[K]['responses'] extends infer R
  ? S extends keyof R ? R[S] extends { content: { 'application/json': infer T } } ? T : never : never : never;
/** The JSON request body of an operation. */
type Body<K extends Op> = operations[K] extends { requestBody: { content: { 'application/json': infer T } } } ? T
  : operations[K] extends { requestBody?: { content: { 'application/json': infer T } } } ? T : never;

/** A task as the management API reports it, with its execution context and recovery when it has them. */
export type Task = Json<'getTask'>;
export type TaskState = Task['state'];
/** The durable admission of a submitted task. */
export type TaskAccepted = Json<'submitTask', 202>;
/** The admission of a paused or resumed task. */
export type TaskAdmission = Json<'pauseTask'>;
/** One journaled task event. `sequence` is the stream cursor. */
export type TaskEvent = Json<'getTaskEvents'>['events'][number];
export type Session = Json<'listSessions'>['sessions'][number];
export type SessionContext = NonNullable<NonNullable<operations['listSessions']['parameters']['query']>['context']>;
export type SessionMessage = Json<'getSessionMessages'>['messages'][number];
/** Execution recovery status of an interrupted task (C3). */
export type Recovery = Json<'getTaskRecovery'>;
export type RecoveryAction = Recovery['actions'][number];
export type RecoveryDecisionBody = Body<'decideTaskRecovery'>;
export type Lineage = Json<'getTaskLineage'>;
/** A manifest 1.0 record of an artifact a task registered. */
export type ArtifactRecord = Json<'listTaskArtifacts'>['artifacts'][number];
/** The manifest 1.1 view (renditions, execution provenance), for transfer-v2 consumers. */
export type ArtifactRecordV2 = Json<'getArtifactManifestV2'>;
export type ArtifactRendition = Json<'listArtifactRenditions'>['renditions'][number];
export type ArtifactImport = Json<'getArtifactImport'>;
export type ArtifactImportRequest = Body<'importArtifact'>;
export type ArtifactImportAccepted = Json<'importArtifact', 202>;
export type OperationalStatus = Json<'getOperationalStatus'>;
/** One page of tasks, newest first; `next` is the cursor of the following page, or null. */
export type TaskPage = Json<'listTasks'>;
export type TaskContext = NonNullable<NonNullable<operations['listTasks']['parameters']['query']>['context']>;
/** A team mission submission body (`POST /api/v1/missions`). */
export type MissionSubmitBody = Body<'submitMission'>;
export type TeamMission = MissionSubmitBody['mission'];
export type MissionContextItem = NonNullable<MissionSubmitBody['context_items']>[number];
/** A preview submission body (`POST /api/v1/preview/tasks`). */
export type PreviewSubmitBody = Body<'submitPreviewTask'>;
export type PreviewOverrides = NonNullable<PreviewSubmitBody['overrides']>;
/** One page of the agent's development history, oldest first. */
export type DevelopmentPage = Json<'listDevelopment'>;
export type DevelopmentRecord = DevelopmentPage['records'][number];
/** An operator (or relayed agent) development note. */
export type DevelopmentNote = Body<'addDevelopmentNote'>;

/** Live reply text, which is not journaled: `text` is a snapshot of the step so far, `delta` an addition. */
export interface TaskText {
  readonly kind: 'text' | 'delta';
  readonly step: number;
  readonly text: string;
}
