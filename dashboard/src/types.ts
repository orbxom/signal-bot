export interface StageMap {
  plan: StageStatus;
  build: StageStatus;
  test: StageStatus;
  simplify: StageStatus;
  pr: StageStatus;
  'integration-test': StageStatus;
  review: StageStatus;
}

export type StageStatus = 'pending' | 'in-progress' | 'complete' | 'deferred' | 'abandoned';

export const STAGE_ORDER: (keyof StageMap)[] = [
  'plan', 'build', 'test', 'simplify', 'pr', 'integration-test', 'review',
];

export interface StatusFile {
  runId: string;
  currentStage: string;
  stages: Partial<StageMap>;
  updatedAt?: string;
}

export interface EventFile {
  source?: string;
  issueNumber?: number;
  issueUrl?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  mode?: string;
  createdAt?: string;
}

export interface Run {
  runId: string;
  event: EventFile;
  status: StatusFile;
  diary: string;
}

export interface SnapshotMessage {
  type: 'snapshot';
  runs: Record<string, Run>;
}

export interface UpdateMessage {
  type: 'update';
  runId: string;
  file: 'status' | 'diary' | 'event';
  data: StatusFile | EventFile | string;
}

export type WsMessage = SnapshotMessage | UpdateMessage;
