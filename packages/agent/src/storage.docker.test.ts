import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateBucketCommand, HeadObjectCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { AgentError, type StorageConfig } from '@microrun/core/protocol';
import { deleteImages, fetchImages, imagesPresent, pinImages, storeImages } from './storage.ts';

const id = randomBytes(3).toString('hex');
const env = `st-${id}`;
const registryName = `mrst-registry-${id}`;
const s3Name = `mrst-s3-${id}`;
const minioUser = 'mrstaccess';
const minioPass = 'mrstsecret-123';
const bucket = `mrst-${id}`;

let workDir = '';
let registryHost = '';
let minioEndpoint = '';

function sh(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function dk(args: string[], input?: string): Promise<string> {
  const r = await sh('docker', args, input);
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const newSha = () => randomBytes(20).toString('hex');

async function labelOf(ref: string): Promise<string | null> {
  const r = await sh('docker', ['image', 'inspect', '-f', '{{index .Config.Labels "mrst"}}', ref]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function buildSet(name: string, variant = ''): Promise<{ images: Record<string, string>; labels: Record<string, string> }> {
  const images: Record<string, string> = {};
  const labels: Record<string, string> = {};
  for (const svc of ['web', 'worker']) {
    const ref = `mrst-${id}-${name}:${svc}`;
    const label = `${id}-${name}-${svc}${variant}`;
    await dk(['build', '-q', '-t', ref, '--label', `mrst=${label}`, '-'], 'FROM busybox:1.36.1\n');
    images[svc] = ref;
    labels[svc] = label;
  }
  return { images, labels };
}

async function purge(images: Record<string, string>): Promise<void> {
  for (const ref of Object.values(images)) {
    const r = await sh('docker', ['image', 'inspect', '-f', '{{.Id}}', ref]);
    if (r.code === 0) await dk(['rmi', '-f', r.stdout.trim()]);
  }
}

async function idsOf(images: Record<string, string>): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [svc, ref] of Object.entries(images)) ids[svc] = (await dk(['image', 'inspect', '-f', '{{.Id}}', ref])).trim();
  return ids;
}

async function expectLabels(images: Record<string, string>, labels: Record<string, string>): Promise<void> {
  for (const [svc, ref] of Object.entries(images)) expect(await labelOf(ref)).toBe(labels[svc]);
}

async function expectAbsent(images: Record<string, string>): Promise<void> {
  for (const ref of Object.values(images)) expect(await labelOf(ref)).toBeNull();
}

async function hostPort(container: string, port: number): Promise<string> {
  const out = (await dk(['port', container, `${port}/tcp`])).trim().split('\n')[0];
  return out.slice(out.lastIndexOf(':') + 1);
}

async function waitHttp(url: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(url).then((r) => r.ok, () => false);
    if (ok) return;
    await sleep(500);
  }
  throw new Error(`${url} never became ready`);
}

function s3Client(): S3Client {
  return new S3Client({
    endpoint: minioEndpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: minioUser, secretAccessKey: minioPass },
  });
}

async function expectStorageFailed(p: Promise<unknown>, kind: string, secret?: string, reason?: string): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AgentError);
  const e = err as AgentError;
  expect(e.code).toBe('STORAGE_FAILED');
  expect(e.params.kind).toBe(kind);
  if (reason) expect(e.params.reason).toBe(reason);
  if (secret) {
    expect(e.message).not.toContain(secret);
    expect(JSON.stringify(e.params)).not.toContain(secret);
    expect(String(e.stack)).not.toContain(secret);
  }
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mrst-'));
  await dk(['pull', '-q', 'busybox:1.36.1']);
  await dk(['run', '-d', '--name', registryName, '-p', '127.0.0.1::5000', 'registry:2']);
  await dk(['run', '-d', '--name', s3Name, '-p', '127.0.0.1::9090', 'adobe/s3mock:4.7.0']);
  registryHost = `127.0.0.1:${await hostPort(registryName, 5000)}`;
  minioEndpoint = `http://127.0.0.1:${await hostPort(s3Name, 9090)}`;
  await waitHttp(`http://${registryHost}/v2/`);
  const client = s3Client();
  for (let i = 0; ; i++) {
    try {
      await client.send(new ListBucketsCommand({}));
      break;
    } catch (e) {
      if (i >= 120) throw e;
      await sleep(500);
    }
  }
  for (let i = 0; ; i++) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      break;
    } catch (e) {
      if (i >= 40) throw e;
      await sleep(500);
    }
  }
  client.destroy();
});

afterAll(async () => {
  await sh('docker', ['rm', '-f', '-v', registryName, s3Name]);
  const refs = (await sh('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).stdout
    .split('\n')
    .filter((r) => r.includes(id));
  if (refs.length) await sh('docker', ['rmi', '-f', ...refs]);
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('local storage', () => {
  let set: Awaited<ReturnType<typeof buildSet>>;
  let cfg: StorageConfig;

  beforeAll(async () => {
    set = await buildSet('local');
    cfg = { kind: 'local', path: join(workDir, 'local') };
  });

  it('round-trips the release images through one archive', async () => {
    const sha = newSha();
    await storeImages(cfg, env, sha, set.images);
    expect((await stat(join(workDir, 'local', env, `${sha}.tar.gz`))).isFile()).toBe(true);

    await purge(set.images);
    await expectAbsent(set.images);
    expect(await imagesPresent(set.images)).toBe(false);

    await fetchImages(cfg, env, sha, set.images);
    expect(await imagesPresent(set.images)).toBe(true);
    await expectLabels(set.images, set.labels);
  });

  it('fetch returns at once when the images are already present', async () => {
    expect(await imagesPresent(set.images)).toBe(true);
    await fetchImages(cfg, env, newSha(), set.images);
    await expectLabels(set.images, set.labels);
  });

  it('fetch of a missing archive fails with STORAGE_FAILED', async () => {
    const ghost = { web: `mrst-${id}-ghost:web` };
    expect(await imagesPresent(ghost)).toBe(false);
    await expectStorageFailed(fetchImages(cfg, env, newSha(), ghost), 'local');
  });

  it('delete removes the archive, the pin tags and the images', async () => {
    const sha = newSha();
    await storeImages(cfg, env, sha, set.images);
    await pinImages(env, sha, set.images);
    const pins = Object.keys(set.images).map((svc) => `microrun-pin/${env}:${sha.slice(0, 12)}-${svc}`);
    for (const pin of pins) expect(await labelOf(pin)).not.toBeNull();

    await deleteImages(cfg, env, sha, set.images);

    await expect(stat(join(workDir, 'local', env, `${sha}.tar.gz`))).rejects.toThrow();
    for (const pin of pins) expect(await labelOf(pin)).toBeNull();
    await expectAbsent(set.images);
  });
});

describe('pinning', () => {
  it('a pinned image survives losing its tag and docker image prune -f', async () => {
    const set = await buildSet('pin');
    const sha = newSha();
    await pinImages(env, sha, set.images);

    for (const ref of Object.values(set.images)) await dk(['rmi', ref]);
    for (const label of Object.values(set.labels)) await dk(['image', 'prune', '-f', '--filter', `label=mrst=${label}`]);

    for (const svc of Object.keys(set.images)) {
      expect(await labelOf(`microrun-pin/${env}:${sha.slice(0, 12)}-${svc}`)).toBe(set.labels[svc]);
    }
  });
});

describe('registry storage', () => {
  it('round-trips through tag + push and pull + tag back, without auth', async () => {
    const set = await buildSet('reg');
    const cfg: StorageConfig = { kind: 'registry', registry: registryHost, repository: 'mrst/app', username: '', password: '' };
    const sha = newSha();

    await storeImages(cfg, env, sha, set.images);
    const tags = (await (await fetch(`http://${registryHost}/v2/mrst/app/tags/list`)).json()) as { tags: string[] };
    expect(tags.tags).toEqual(expect.arrayContaining([`${env}-${sha}-web`, `${env}-${sha}-worker`]));

    await purge(set.images);
    await expectAbsent(set.images);

    await fetchImages(cfg, env, sha, set.images);
    expect(await imagesPresent(set.images)).toBe(true);
    await expectLabels(set.images, set.labels);
  });

  it('a failed login is STORAGE_FAILED with the password redacted', async () => {
    const set = await buildSet('regfail');
    const secret = `mrst-hunter2-${id}`;
    const cfg: StorageConfig = { kind: 'registry', registry: '127.0.0.1:1', repository: 'mrst/app', username: 'bot', password: secret };
    await expectStorageFailed(storeImages(cfg, env, newSha(), set.images), 'registry', secret);
  });
});

describe('s3 storage', () => {
  let set: Awaited<ReturnType<typeof buildSet>>;
  let cfg: StorageConfig;
  const sha = newSha();
  const key = () => `releases/${env}/${sha}.tar.gz`;

  beforeAll(async () => {
    set = await buildSet('s3');
    cfg = {
      kind: 's3', endpoint: minioEndpoint, region: 'us-east-1', bucket, prefix: 'releases',
      accessKey: minioUser, secretKey: minioPass, forcePathStyle: true,
    };
  });

  it('round-trips through an uploaded archive', async () => {
    await storeImages(cfg, env, sha, set.images);
    const client = s3Client();
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key() }));
    client.destroy();
    expect(head.ContentLength ?? 0).toBeGreaterThan(0);

    await purge(set.images);
    await expectAbsent(set.images);

    await fetchImages(cfg, env, sha, set.images);
    expect(await imagesPresent(set.images)).toBe(true);
    await expectLabels(set.images, set.labels);
  });

  it('delete removes the object', async () => {
    await deleteImages(cfg, env, sha, set.images);
    const client = s3Client();
    const err = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key() })).then(() => null, (e: unknown) => e);
    client.destroy();
    expect((err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode).toBe(404);
  });
});

describe('digest verification on fetch', () => {
  it('loads a local archive whose images match the given digests', async () => {
    const cfg: StorageConfig = { kind: 'local', path: join(workDir, 'digest-ok') };
    const set = await buildSet('digok');
    const digests = await idsOf(set.images);
    const sha = newSha();
    await storeImages(cfg, env, sha, set.images);
    await purge(set.images);

    await fetchImages(cfg, env, sha, set.images, digests);
    await expectLabels(set.images, set.labels);
  });

  it('rejects a tampered local archive under the same file name and removes the loaded images', async () => {
    const cfg: StorageConfig = { kind: 'local', path: join(workDir, 'digest-bad') };
    const set = await buildSet('digbad');
    const digests = await idsOf(set.images);
    const sha = newSha();
    await storeImages(cfg, env, sha, set.images);
    const evil = await buildSet('digbad', '-evil');
    await storeImages(cfg, env, sha, evil.images);
    await purge(evil.images);
    await expectAbsent(set.images);

    await expectStorageFailed(fetchImages(cfg, env, sha, set.images, digests), 'local', undefined, 'digest');
    await expectAbsent(set.images);
  });

  it('accepts registry images whose digest matches and rejects a tag that was re-pushed with other content', async () => {
    const cfg: StorageConfig = { kind: 'registry', registry: registryHost, repository: 'mrst/dig', username: '', password: '' };
    const set = await buildSet('digreg');
    const digests = await idsOf(set.images);
    const good = newSha();
    await storeImages(cfg, env, good, set.images);
    await purge(set.images);
    await fetchImages(cfg, env, good, set.images, digests);
    await expectLabels(set.images, set.labels);

    const bad = newSha();
    await storeImages(cfg, env, bad, set.images);
    const evil = await buildSet('digreg', '-evil');
    for (const [svc, ref] of Object.entries(evil.images)) {
      const remote = `${registryHost}/mrst/dig:${env}-${bad}-${svc}`;
      await dk(['tag', ref, remote]);
      await dk(['push', '-q', remote]);
      await dk(['rmi', remote]);
    }
    await purge(evil.images);
    await expectAbsent(set.images);

    await expectStorageFailed(fetchImages(cfg, env, bad, set.images, digests), 'registry', undefined, 'digest');
    await expectAbsent(set.images);
  });
});

describe('environment names that are not valid image refs', () => {
  const spaced = `My Env ${id}`;
  const slugged = `my-env-${id}`;

  it('stores and fetches a local archive under the slugged env directory', async () => {
    const cfg: StorageConfig = { kind: 'local', path: join(workDir, 'slug') };
    const set = await buildSet('slugloc');
    const sha = newSha();
    await storeImages(cfg, spaced, sha, set.images);
    expect((await stat(join(workDir, 'slug', slugged, `${sha}.tar.gz`))).isFile()).toBe(true);

    await purge(set.images);
    await fetchImages(cfg, spaced, sha, set.images);
    await expectLabels(set.images, set.labels);

    await deleteImages(cfg, spaced, sha, set.images);
    await expect(stat(join(workDir, 'slug', slugged, `${sha}.tar.gz`))).rejects.toThrow();
  });

  it('pins under microrun-pin/<slug> and deletes those pins', async () => {
    const cfg: StorageConfig = { kind: 'local', path: join(workDir, 'slugpin') };
    const set = await buildSet('slugpin');
    const sha = newSha();
    await pinImages(` Prod/EU ${id} `, sha, set.images);
    const pins = Object.keys(set.images).map((svc) => `microrun-pin/prod-eu-${id}:${sha.slice(0, 12)}-${svc}`);
    for (const [i, pin] of pins.entries()) expect(await labelOf(pin)).toBe(Object.values(set.labels)[i]);

    await deleteImages(cfg, ` Prod/EU ${id} `, sha, set.images);
    for (const pin of pins) expect(await labelOf(pin)).toBeNull();
  });

  it('pushes registry tags with the slugged env and pulls them back', async () => {
    const cfg: StorageConfig = { kind: 'registry', registry: registryHost, repository: 'mrst/slug', username: '', password: '' };
    const set = await buildSet('slugreg');
    const sha = newSha();
    await storeImages(cfg, spaced, sha, set.images);
    const tags = (await (await fetch(`http://${registryHost}/v2/mrst/slug/tags/list`)).json()) as { tags: string[] };
    expect(tags.tags).toEqual(expect.arrayContaining([`${slugged}-${sha}-web`, `${slugged}-${sha}-worker`]));

    await purge(set.images);
    await fetchImages(cfg, spaced, sha, set.images);
    await expectLabels(set.images, set.labels);
  });

  it('uploads the s3 object under the slugged env key', async () => {
    const cfg: StorageConfig = {
      kind: 's3', endpoint: minioEndpoint, region: 'us-east-1', bucket, prefix: 'releases',
      accessKey: minioUser, secretKey: minioPass, forcePathStyle: true,
    };
    const set = await buildSet('slugs3');
    const sha = newSha();
    await storeImages(cfg, spaced, sha, set.images);
    const client = s3Client();
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: `releases/${slugged}/${sha}.tar.gz` }))
      .then((h) => h.ContentLength ?? 0, () => -1);
    client.destroy();
    expect(head).toBeGreaterThan(0);
  });
});
