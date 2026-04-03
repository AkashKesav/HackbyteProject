import { DEFAULT_RESOLUTION_SOURCE } from '../constants';
import type { ExtensionConfig, ResolutionCandidate } from '../types';
import { callReducer } from './client';

export async function resolveTasks(
  config: ExtensionConfig,
  candidates: ResolutionCandidate[]
): Promise<void> {
  for (const candidate of candidates) {
    const commitHashArg = candidate.commitHash
      ? { some: candidate.commitHash }
      : { none: [] as [] };

    await callReducer(config, 'resolve_task_from_inference', [
      candidate.taskId,
      candidate.reason,
      DEFAULT_RESOLUTION_SOURCE,
      commitHashArg,
      candidate.documentRefs,
    ]);
  }
}
