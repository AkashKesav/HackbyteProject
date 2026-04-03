import { z } from 'zod';

export const resolutionCandidateSchema = z.object({
  taskId: z.number().int().nonnegative(),
  shouldClose: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  commitHash: z.string().trim().min(1).optional(),
  documentRefs: z.array(z.string().trim().min(1)).default([]),
  evidenceSummary: z.string().default(''),
  matchedSignals: z.array(z.string().trim().min(1)).default([]),
});

export const geminiResolutionResponseSchema = z.object({
  candidates: z.array(resolutionCandidateSchema).default([]),
});

export const geminiResolutionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'taskId',
          'shouldClose',
          'confidence',
          'reason',
          'documentRefs',
          'evidenceSummary',
          'matchedSignals',
        ],
        properties: {
          taskId: { type: 'integer', minimum: 0 },
          shouldClose: { type: 'boolean' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
          commitHash: { type: 'string' },
          documentRefs: {
            type: 'array',
            items: { type: 'string' },
          },
          evidenceSummary: { type: 'string' },
          matchedSignals: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
} as const;
