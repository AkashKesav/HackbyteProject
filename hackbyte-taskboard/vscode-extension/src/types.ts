export type TaskStatus = 'todo' | 'in_progress' | 'done';

export interface ExtensionConfig {
  spacetimeHttpUrl: string;
  databaseName: string;
  boardUrl: string;
  geminiModel: string;
  recentCommitCount: number;
  recentDocLookbackHours: number;
  confidenceThreshold: number;
  maxCommitDiffChars: number;
  maxDocumentExcerptChars: number;
  maxRecentDocs: number;
}

export interface OpenTask {
  id: number;
  title: string;
  status: TaskStatus;
  source: string;
  commitHash?: string;
  context: string;
  createdAt: string;
  authorIdentity?: string;
  resolutionKind: string;
  resolutionSource: string;
  resolutionContext: string;
  resolutionCommitHash?: string;
  resolutionDocumentRefs: string[];
}

export interface RecentCommitEvidence {
  hash: string;
  subject: string;
  committedAt: string;
  changedFiles: string[];
  diffSummary: string;
}

export interface CollectedCommitContext {
  repoRoot: string;
  branch: string;
  commits: RecentCommitEvidence[];
}

export interface RecentDocumentEvidence {
  relativePath: string;
  modifiedAt: string;
  excerpt: string;
  relatedCommitHashes: string[];
  source: 'workspace';
}

export interface ResolutionCandidate {
  taskId: number;
  shouldClose: boolean;
  confidence: number;
  reason: string;
  commitHash?: string;
  documentRefs: string[];
  evidenceSummary: string;
  matchedSignals: string[];
}

export interface GeminiResolutionResponse {
  candidates: ResolutionCandidate[];
}

export interface SqlSchemaElement {
  name?: { some?: string };
}

export interface SqlQueryResponse {
  schema: {
    elements: SqlSchemaElement[];
  };
  rows: unknown[][];
}
