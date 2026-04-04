import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const entryPoint = path.join(rootDir, 'src', 'extension.ts');
const outFile = path.join(rootDir, 'out', 'extension.js');
const watch = process.argv.includes('--watch');

const options = {
  absWorkingDir: rootDir,
  entryPoints: [entryPoint],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info'
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[lcn-extension] watching for changes');
} else {
  await build(options);
}
