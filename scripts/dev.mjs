import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const processes = [];
let ending = false;
function shutdown(code = 0) {
  if (ending) return;
  ending = true;
  for (const child of processes) child.kill('SIGTERM');
  process.exitCode = code;
}
const env = { ...process.env, CFD_ALLOWED_ORIGINS: process.env.CFD_ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173' };
for (const [tool, args] of [['tsx', ['server/index.ts']], ['vite', ['--host', '0.0.0.0', '--port', '5173', '--strictPort']]]) {
  const child = spawn(path.join(root, 'node_modules', '.bin', tool), args, { cwd: root, env, stdio: 'inherit' });
  processes.push(child);
  child.on('error', error => { console.error(error.message); shutdown(1); });
  child.on('exit', code => { if (!ending) shutdown(code || 0); });
}
process.once('SIGINT', () => shutdown());
process.once('SIGTERM', () => shutdown());
