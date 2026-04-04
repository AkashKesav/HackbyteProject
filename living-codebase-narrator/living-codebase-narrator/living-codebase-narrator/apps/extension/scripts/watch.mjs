import { spawn } from 'node:child_process';

const cmd = process.platform === 'win32' ? 'node.exe' : 'node';
const es = spawn(cmd, ['./scripts/build.mjs', '--watch'], { stdio: 'inherit' });

es.on('exit', (code) => process.exit(code ?? 0));

