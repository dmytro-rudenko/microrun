import { describe, expect, it } from 'vitest';
import { composeArgs } from './compose.ts';

describe('composeArgs', () => {
  const base = { project: 'shop', dir: '/nonexistent/shop', files: ['deploy/compose.yml'] };

  it('passes no --env-file when the environment lists none', () => {
    expect(composeArgs(base, ['ps'])).toEqual([
      'compose', '-p', 'shop', '--project-directory', '/nonexistent/shop', '-f', '/nonexistent/shop/deploy/compose.yml', 'ps',
    ]);
  });

  it('passes each env file as --env-file, relative paths resolved against the compose dir, before the subcommand', () => {
    expect(composeArgs({ ...base, envFiles: ['/etc/shop/.env', 'prod.env'] }, ['config'])).toEqual([
      'compose', '-p', 'shop', '--project-directory', '/nonexistent/shop', '-f', '/nonexistent/shop/deploy/compose.yml',
      '--env-file', '/etc/shop/.env', '--env-file', '/nonexistent/shop/prod.env', 'config',
    ]);
  });
});
