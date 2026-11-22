import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import {
  ADMIN_PASSWORD, ADMIN_USER, MICRORUN_URL, buildImages, cliDeploy, getJson, listeningPids, postJson,
  prepareFixtureDir, psql, startFixture, startMicrorun, startNpmAgent, teardown, waitFor,
} from './helpers.ts';

const SHA_V1 = 'a'.repeat(40);
const SHA_V2 = 'b'.repeat(40);
const SHA_V3 = 'c'.repeat(40);
const SHA_BAD = 'd'.repeat(40);
const LANGS = ['en', 'uk', 'de', 'fr', 'es', 'pt-BR', 'pl', 'zh-CN'];
const RAW_KEY = /\b(nav|state|rb|cl|codes|settings|hist|env)\.[a-zA-Z]+/;

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let fixtureDir: string;
let npmAgent: ChildProcess | undefined;
let deployToken = '';
let rolledBackAt = 0;

const deploy = (image: string, commit: string, message: string) =>
  cliDeploy(['--url', MICRORUN_URL, '--token', deployToken, '--image', image, '--commit', commit, '--branch', 'prod', '--author', 'e2e', '--message', message]);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(900_000);
  await buildImages();
  fixtureDir = prepareFixtureDir();
  await startFixture(fixtureDir);
  await startMicrorun(fixtureDir);
  context = await browser.newContext({ baseURL: MICRORUN_URL });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await teardown(fixtureDir, npmAgent);
});

test('login rejects wrong credentials and accepts ENV ones', async () => {
  await page.goto('/login');
  await page.fill('#username', ADMIN_USER);
  await page.fill('#password', 'wrong-password');
  await page.click('[data-testid=login-submit]');
  await expect(page.locator('[data-testid=login-error]')).toBeVisible();

  await page.fill('#username', ADMIN_USER);
  await page.fill('#password', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await expect(page).toHaveURL(`${MICRORUN_URL}/`);
});

test('remote npm agent comes online without inbound ports', async () => {
  await page.goto('/env/new');
  await page.fill('[data-testid=server-name]', 'remote-1');
  await page.click('[data-testid=server-create]');
  const token = (await page.locator('[data-testid=agent-token]').innerText()).trim();
  expect(token.length).toBeGreaterThan(20);

  npmAgent = startNpmAgent(token);
  expect(npmAgent.pid).toBeDefined();
  await page.waitForTimeout(3000);
  expect(await listeningPids()).not.toContain(`pid=${npmAgent.pid},`);

  await expect(async () => {
    await page.goto('/env/new');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/settings/servers/block')),
      page.selectOption('[name=server_id]', { label: 'remote-1' }),
    ]);
    await expect(page.locator('[data-testid=agent-status]')).toHaveAttribute('data-status', 'online');
  }).toPass({ timeout: 20_000 });
});

async function fillEnvForm(name: string, branch: string, production: boolean) {
  await page.goto('/env/new');
  await page.fill('[name=name]', name);
  await page.fill('[name=branch]', branch);
  if (production) await page.check('[name=is_production]');
  await page.selectOption('[name=server_id]', { label: 'local' });
  await page.waitForLoadState('networkidle');
  await page.fill('[name=compose_project]', 'mrfix');
  await page.fill('[name=compose_dir]', fixtureDir);
  await page.fill('[name=compose_files]', 'compose.yml');
  await page.fill('[name=services]', 'web:rolling\nworker:recreate');
  await page.fill('[name=migration_service]', 'web');
  await page.selectOption('[name=db_kind]', 'postgres');
  await page.fill('[name=db_url_env]', 'DATABASE_URL');
  await page.fill('[name=expand_cmd]', 'node migrate.mjs expand');
  await page.fill('[name=contract_cmd]', 'node migrate.mjs contract');
  await page.fill('[name=cleanup_cmd]', 'node migrate.mjs cleanup');
  await page.selectOption('[name=schema_check]', 'dry_run');
  await page.selectOption('[name=storage_kind]', 'local');
  await page.fill('[name=storage_path]', '/tmp/mr-e2e-store');
  await page.fill('[name=retention_value]', '90');
  await page.selectOption('[name=retention_unit]', 'days');
  await page.click('[data-testid=env-save]');
  await expect(page.locator('[data-testid=deploy-token]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid=env-error]')).toHaveCount(0);
}

test('production env is configured and its database bound', async () => {
  await fillEnvForm('production', 'prod', true);
  deployToken = (await page.locator('[data-testid=deploy-token]').innerText()).trim();
  expect(deployToken.length).toBeGreaterThan(20);

  await page.click('[data-testid=env-bind-db]');
  await expect(page.locator('[data-testid=bind-result]')).toHaveAttribute('data-ok', 'true', { timeout: 60_000 });
});

test('binding a database owned by another environment is rejected with its name', async () => {
  await fillEnvForm('stage', 'stage', false);
  await page.click('[data-testid=env-bind-db]');
  const result = page.locator('[data-testid=bind-result]');
  await expect(result).toHaveAttribute('data-ok', 'false', { timeout: 60_000 });
  await expect(result).toContainText('production');
});

test('deploy v1 then v2, write data, roll back within 60 s keeping old fields', async () => {
  const v1 = await deploy('microrun-fixture:v1', SHA_V1, 'v1');
  expect(v1.code, v1.output).toBe(0);
  expect(await postJson('/users', { name: 'Ann', email: 'ann@x' }).then(r => r.status)).toBe(201);

  const v2 = await deploy('microrun-fixture:v2', SHA_V2, 'v2');
  expect(v2.code, v2.output).toBe(0);
  expect((await getJson<{ version: string }>('/version')).version).toBe('v2');
  expect(await postJson('/users', { name: 'Bob', email: 'bob@x' }).then(r => r.status)).toBe(201);
  expect(await postJson('/login', {}).then(r => r.status)).toBe(200);

  await page.goto('/');
  await page.click('[data-testid=rel-production-aaaaaaa]');
  await page.click('[data-testid=rollback-go]');
  const started = Date.now();
  await page.click('[data-testid=confirm-yes]');
  await expect(page.locator('[data-testid=rollback-done]')).toBeVisible({ timeout: 60_000 });
  expect(Date.now() - started).toBeLessThan(60_000);
  rolledBackAt = Date.now();

  await waitFor(async () => (await getJson<{ version: string }>('/version')).version === 'v1', 10_000);
  const users = await getJson<{ name: string; email: string }[]>('/users');
  expect(users.map(u => [u.name, u.email])).toEqual([['Ann', 'ann@x'], ['Bob', 'bob@x']]);

  await page.goto('/');
  await expect(page.locator('[data-testid=rel-production-bbbbbbb]')).toHaveAttribute('data-state', 'blocked');
});

test('cleanup shows the count and deletes after confirmation', async () => {
  await page.goto('/');
  await page.click('[data-testid=rel-production-bbbbbbb]');
  const rule = page.locator('[data-testid=cleanup-rule-promo-notifications]');
  await expect(rule).toContainText('50', { timeout: 60_000 });
  await page.click('[data-testid=cleanup-apply]');
  await expect(page.locator('[data-testid=cleanup-result]')).toContainText('50', { timeout: 60_000 });
  expect(await psql(fixtureDir, "select count(*) from notifications where type='promo'")).toBe('0');
});

test('redeploying the blocked commit exits 2 with COMMIT_BLOCKED, commit and date', async () => {
  const res = await deploy('microrun-fixture:v2', SHA_V2, 'v2 again');
  expect(res.code, res.output).toBe(2);
  expect(res.output).toContain('COMMIT_BLOCKED');
  expect(res.output).toContain('bbbbbbb');
  const fmt = (ms: number) => new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(ms);
  const days = [fmt(rolledBackAt), fmt(rolledBackAt - 86_400_000)];
  expect(days.some(d => res.output.includes(d)), `${days.join(' | ')} in ${res.output}`).toBe(true);
});

test('a new commit deploys normally', async () => {
  const res = await deploy('microrun-fixture:v3', SHA_V3, 'v3');
  expect(res.code, res.output).toBe(0);
  expect((await getJson<{ version: string }>('/version')).version).toBe('v3');
});

test('production rollback asks for confirmation and No cancels', async () => {
  await page.goto('/');
  await page.click('[data-testid=rel-production-aaaaaaa]');
  const ask = page.locator('[data-testid=confirm-ask]');
  await expect(ask).toBeHidden();
  await page.click('[data-testid=rollback-go]');
  await expect(ask).toBeVisible();
  await page.click('[data-testid=confirm-no]');
  await expect(ask).toBeHidden();
  await expect(page.locator('[data-testid=rollback-go]')).toBeVisible();
});

test('destructive migration is rejected before touching the database', async () => {
  const res = await deploy('microrun-fixture:vbad', SHA_BAD, 'drop email');
  expect(res.code, res.output).toBe(2);
  expect(res.output).toContain('SCHEMA_DESTRUCTIVE');
  expect(await psql(fixtureDir, "select count(*) from information_schema.columns where table_name='users' and column_name='email'")).toBe('1');
});

test('UI renders in all 8 languages without raw keys', async () => {
  await page.goto('/');
  const envHref = await page.locator('[data-testid=col-production] a[href^="/env/"]').first().getAttribute('href');
  expect(envHref).toMatch(/^\/env\//);
  for (const lang of LANGS) {
    await page.goto('/');
    await page.selectOption('[data-testid=lang]', lang);
    await page.waitForLoadState('networkidle');
    for (const path of ['/', envHref!]) {
      await page.goto(path);
      const text = await page.locator('body').innerText();
      expect(text, `${lang} ${path}`).not.toMatch(RAW_KEY);
      expect(text, `${lang} ${path}`).not.toMatch(/undefined|NaN/);
    }
  }
});

test('login page switches language before sign-in', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: MICRORUN_URL });
  const p = await ctx.newPage();
  await p.goto('/login');
  await expect(p.locator('html')).toHaveAttribute('lang', 'en');
  await p.selectOption('[data-testid=login-lang]', 'uk');
  await expect(p.locator('html')).toHaveAttribute('lang', 'uk');
  await ctx.close();
});

test('a server without environments is deleted through the confirmation dialog', async () => {
  await page.goto('/env/new');
  await page.fill('[data-testid=server-name]', 'temp-1');
  await page.click('[data-testid=server-create]');
  await expect(page.locator('#srv [data-testid=agent-token]')).toBeVisible();
  await page.click('[data-testid=server-delete-temp-1]');
  const go = page.locator('[data-testid=server-delete-go-temp-1]');
  await expect(go).toBeDisabled();
  await page.fill('[data-testid=server-delete-name-temp-1]', 'temp-1');
  await expect(go).toBeEnabled();
  await go.click();
  await expect(page.locator('#srv [data-testid=server-delete-temp-1]')).toHaveCount(0);
  await expect(page.locator('#srv select[name=server_id] option', { hasText: 'temp-1' })).toHaveCount(0);
});
