import { GoogleGenAI } from '@google/genai';
import {
  geminiResolutionJsonSchema,
  geminiResolutionResponseSchema,
} from './schema';
import { buildResolutionPrompt } from './buildResolutionPrompt';
import type {
  GeminiResolutionResponse,
  OpenTask,
  RecentCommitEvidence,
  RecentDocumentEvidence,
} from '../types';

export async function inferTaskResolutions({
  apiKey,
  model,
  branch,
  openTasks,
  commits,
  documents,
}: {
  apiKey: string;
  model: string;
  branch: string;
  openTasks: OpenTask[];
  commits: RecentCommitEvidence[];
  documents: RecentDocumentEvidence[];
}): Promise<GeminiResolutionResponse> {
  const client = new GoogleGenAI({ apiKey });
  const prompt = buildResolutionPrompt({
    branch,
    openTasks,
    commits,
    documents,
  });

  const response = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseJsonSchema: geminiResolutionJsonSchema,
    },
  });

  const text = getResponseText(response);
  const parsed = JSON.parse(text);
  return geminiResolutionResponseSchema.parse(parsed);
}

function getResponseText(response: { text?: string | (() => string) }): string {
  if (typeof response.text === 'function') {
    return response.text();
  }

  if (typeof response.text === 'string') {
    return response.text;
  }

  throw new Error('Gemini response did not include text output.');
}
