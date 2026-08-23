#!/usr/bin/env node
// Caps test-runner parallelism on developer machines. Under CI the command is
// exec'd unchanged, so runner behaviour is identical to before this wrapper.
// Override locally with TEST_CONCURRENCY / TURBO_CONCURRENCY.
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: node scripts/captest.mjs <command> [args...]');
  process.exit(1);
}

const vars = process.env;
const childEnv = { ...vars };
const args = [...argv];

if (!vars.CI) {
  const workers = vars.TEST_CONCURRENCY || '4';
  // vitest v4 reads MAX_WORKERS; v3 reads MAX_FORKS/MAX_THREADS. Extras are ignored.
  childEnv.VITEST_MAX_WORKERS ||= workers;
  childEnv.VITEST_MAX_FORKS ||= workers;
  childEnv.VITEST_MAX_THREADS ||= workers;

  const passthrough = args.indexOf('--');
  const end = passthrough === -1 ? args.length : passthrough;
  const head = args.slice(0, end);

  if (args[0] === 'turbo' && !head.some((a) => a.startsWith('--concurrency'))) {
    args.splice(end, 0, `--concurrency=${vars.TURBO_CONCURRENCY || '2'}`);
  }
  if (head.includes('--test') && !head.some((a) => a.startsWith('--test-concurrency'))) {
    args.splice(1, 0, `--test-concurrency=${workers}`);
  }
}

spawn(args[0], args.slice(1), { stdio: 'inherit', env: childEnv }).on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
