export const EXTENSION_NAMESPACE = 'hackbyteTaskboard';
export const GEMINI_API_KEY_SECRET = 'hackbyteTaskboard.geminiApiKey';
export const DEFAULT_SPACETIME_HTTP_URL = 'http://127.0.0.1:3000';
export const DEFAULT_DATABASE_NAME = 'hackbyte-taskboard';
export const DEFAULT_BOARD_URL = 'http://127.0.0.1:5173/';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_RESOLUTION_SOURCE = 'gemini_commit_doc_match';

export const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'shared/module_bindings',
  'src/module_bindings',
]);
