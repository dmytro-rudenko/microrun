import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AGENT_VERSION } from './handler.ts';
import { runAgent } from './runtime.ts';
import { runDeploy } from './cli-deploy.ts';

const USAGE = [
  'usage:',
  '  microrun agent [--url <url>] [--token <token>] [--state-dir <dir>]',
  '  microrun agent install-service [--url <url>] [--token <token>] [--state-dir <dir>]',
  '  microrun deploy ...',
  '  microrun --version',
].join('\n');

const out = (s: string) => void process.stdout.write(`${s}\n`);
const err = (s: string) => void process.stderr.write(`${s}\n`);

const ENV_FILE = '/etc/microrun/agent.env';

function unit(url: string, stateDir: string | undefined): string {
  const bin = fileURLToPath(import.meta.url);
  return [
    '[Unit]',
    'Description=microrun agent',
    'After=network-online.target docker.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${process.execPath} ${bin} agent${stateDir ? ` --state-dir ${stateDir}` : ''}`,
    `Environment=MICRORUN_URL=${url}`,
    `EnvironmentFile=${ENV_FILE}`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

async function agent(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const install = argv[0] === 'install-service';
  let values: { url?: string; token?: string; 'state-dir'?: string };
  try {
    values = parseArgs({
      args: install ? argv.slice(1) : argv,
      options: { url: { type: 'string' }, token: { type: 'string' }, 'state-dir': { type: 'string' } },
    }).values;
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 1;
  }
  const url = values.url ?? env.MICRORUN_URL;
  const token = values.token ?? env.MICRORUN_AGENT_TOKEN;
  if (!url) {
    err(`microrun agent: --url or MICRORUN_URL is required\n${USAGE}`);
    return 1;
  }
  if (install) {
    process.stdout.write(unit(url, values['state-dir']));
    err([
      `microrun agent: the unit reads MICRORUN_AGENT_TOKEN from ${ENV_FILE}; create it readable by root only:`,
      `  sudo install -d -m 700 /etc/microrun`,
      `  printf 'MICRORUN_AGENT_TOKEN=%s\\n' '<token>' | sudo install -m 600 /dev/stdin ${ENV_FILE}`,
    ].join('\n'));
    return 0;
  }
  if (!token) {
    err(`microrun agent: --token or MICRORUN_AGENT_TOKEN is required\n${USAGE}`);
    return 1;
  }
  const stateDir = values['state-dir'] ?? join(homedir(), '.microrun');
  mkdirSync(stateDir, { recursive: true });
  const running = runAgent({ url, token, stateDir, version: AGENT_VERSION });
  return new Promise<number>((resolve) => {
    const shutdown = () => void running.stop().then(() => resolve(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === '--version' || cmd === '-v') {
    out(AGENT_VERSION);
    return 0;
  }
  if (cmd === 'agent') return agent(rest, env);
  if (cmd === 'deploy') return runDeploy(rest, env);
  err(USAGE);
  return 1;
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
