import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../env.js';

export type GeneratedDocJson = {
  summary: string;
  what_changed: string[];
  why_it_matters: string[];
  tags: string[];
};

let lastProvider: 'huggingface' | 'gemini' | null = null;
let lastError: string | null = null;

export function isGeminiConfigured() {
  return Boolean(env.GEMINI_API_KEY);
}

export function isHuggingFaceConfigured() {
  return Boolean(env.HF_TOKEN && env.HF_MODEL);
}

export function llmState() {
  return { lastProvider, lastError };
}

function buildPrompt(input: {
  filePath: string;
  language: string;
  diff: string;
  context: string;
}) {
  return [
    `You are "Living Codebase Narrator".`,
    `Generate concise teammate-friendly documentation from a code diff and context.`,
    ``,
    `Return STRICT JSON with keys:`,
    `- summary (string, 1-2 sentences)`,
    `- what_changed (array of short bullets)`,
    `- why_it_matters (array of short bullets focused on intent/impact)`,
    `- tags (array of lowercase short tags, 2-6 items)`,
    ``,
    `File: ${input.filePath}`,
    `Language: ${input.language}`,
    ``,
    `Unified diff:`,
    input.diff,
    ``,
    `Context (surrounding code or excerpt):`,
    input.context
  ].join('\n');
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Model response did not contain JSON');
  }
  return candidate.slice(start, end + 1);
}

async function generateDocsWithHuggingFace(input: {
  filePath: string;
  language: string;
  diff: string;
  context: string;
}): Promise<GeneratedDocJson> {
  if (!isHuggingFaceConfigured()) {
    throw new Error('Hugging Face not configured');
  }

  const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.HF_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: env.HF_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You convert code diffs into strict JSON documentation. Reply with JSON only and no markdown.'
        },
        {
          role: 'user',
          content: buildPrompt(input)
        }
      ],
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: 'json_object' }
    })
  });

  if (!res.ok) {
    throw new Error(`Hugging Face request failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Hugging Face returned no message content');
  }

  lastProvider = 'huggingface';
  lastError = null;
  return JSON.parse(extractJsonObject(content)) as GeneratedDocJson;
}

export async function generateDocsWithGemini(input: {
  filePath: string;
  language: string;
  diff: string;
  context: string;
}): Promise<GeneratedDocJson> {
  if (isHuggingFaceConfigured()) {
    try {
      return await generateDocsWithHuggingFace(input);
    } catch (error) {
      lastProvider = 'huggingface';
      lastError = String(error);
      if (!isGeminiConfigured()) throw error;
    }
  }

  if (!isGeminiConfigured()) throw new Error('Gemini not configured');

  const genai = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({
    model: env.GEMINI_MODEL,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json'
    }
  });

  const res = await model.generateContent(buildPrompt(input));
  const text = res.response.text();
  const parsed = JSON.parse(text) as GeneratedDocJson;
  lastProvider = 'gemini';
  lastError = null;
  return parsed;
}

