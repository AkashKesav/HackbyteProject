import path from 'node:path';
import dotenv from 'dotenv';

const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(process.cwd(), '../../.env.local'),
  path.resolve(process.cwd(), '../../../../../.env'),
  path.resolve(process.cwd(), '../../../../../.env.local')
];

for (const filePath of envCandidates) {
  dotenv.config({ path: filePath, override: false });
}

export const env = {
  PORT: Number(process.env.PORT ?? '8787'),
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787',
  LOCAL_DATA_DIR: process.env.LOCAL_DATA_DIR ?? '.data',

  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? '',
  GEMINI_MODEL: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite',

  HF_TOKEN: process.env.HF_TOKEN ?? '',
  HF_MODEL: process.env.HF_MODEL ?? 'Qwen/Qwen2.5-Coder-32B-Instruct',

  MONGODB_URI: process.env.MONGODB_URI ?? '',
  MONGODB_DB: process.env.MONGODB_DB ?? 'living_codebase_narrator',

  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY ?? '',
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM',
  NARRATOR_HEADING_PREFIX:
    process.env.NARRATOR_HEADING_PREFIX ?? 'Latest code update.',

  SPACETIME_SERVER_URL: process.env.SPACETIME_SERVER_URL ?? '',
  SPACETIME_MODULE_NAME: process.env.SPACETIME_MODULE_NAME ?? ''
};
