export type CodeDeltaStatus = 'new' | 'processed' | 'ignored' | 'error';
export type DocEntryStatus = 'draft' | 'published' | 'archived';

export type CodeDelta = {
  id: string;
  sessionId: string;
  author: string;
  filePath: string;
  language: string;
  diff: string;
  context: string;
  changedLines: number;
  source: 'vscode';
  repo?: string;
  branch?: string;
  status: CodeDeltaStatus;
  createdAt: string;
  updatedAt: string;
};

export type DocEntry = {
  id: string;
  deltaId: string;
  sessionId: string;
  author: string;
  filePath: string;
  language: string;
  lines: { start: number; end: number } | null;
  diff: string;
  context: string;
  summary: string;
  whatChanged: string[];
  whyItMatters: string[];
  tags: string[];
  audioUrl: string | null;
  votes: { up: number; down: number };
  annotations: Array<{
    id: string;
    author: string;
    text: string;
    createdAt: string;
  }>;
  status: DocEntryStatus;
  source: 'vscode';
  commitSha?: string;
  commitMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type HealthResponse = {
  ok: boolean;
  time: string;
  integrations: {
    gemini: { configured: boolean };
    huggingface: { configured: boolean };
    elevenlabs: { configured: boolean };
    mongodb: { configured: boolean; connected: boolean };
    spacetime: { configured: boolean };
  };
};

