// Starts the built API and worker together for end-to-end tests (Playwright manages one process).
// Run `pnpm --filter @insightai/api build` first. Stops both when either exits or on a signal.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const children = ['dist/worker.js', 'dist/main.js'].map((entry) =>
  spawn(process.execPath, [entry], {
    cwd: `${root}apps/api`,
    env: process.env,
    stdio: 'inherit',
  }),
);
const stop = (code = 0) => {
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
};
for (const child of children) child.on('exit', (code) => stop(code ?? 1));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
