import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('Watching VS Code extension bundle...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
