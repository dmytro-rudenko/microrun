import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { AgentError, type StorageConfig } from '@microrun/core/protocol';
import { docker } from './docker.ts';

type S3Config = Extract<StorageConfig, { kind: 's3' }>;
type RegistryConfig = Extract<StorageConfig, { kind: 'registry' }>;

const pinRef = (env: string, sha: string, svc: string) => `microrun-pin/${env}:${sha.slice(0, 12)}-${svc}`;
const archiveName = (env: string, sha: string) => `${env}/${sha}.tar.gz`;
const localFile = (path: string, env: string, sha: string) => join(path, archiveName(env, sha));
const remoteRef = (s: RegistryConfig, env: string, sha: string, svc: string) => `${s.registry}/${s.repository}:${env}-${sha}-${svc}`;

function s3Key(s: S3Config, env: string, sha: string): string {
  const prefix = s.prefix.replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/${archiveName(env, sha)}` : archiveName(env, sha);
}

function s3Client(s: S3Config): S3Client {
  return new S3Client({
    endpoint: s.endpoint,
    region: s.region,
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
  });
}

async function run(args: string[], opts: Parameters<typeof docker>[1] = {}): Promise<void> {
  const r = await docker(args, opts);
  if (r.code !== 0) throw new Error(r.stderr);
}

function exited(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function save(refs: string[], sink: Writable, alongside: Promise<unknown> = Promise.resolve()): Promise<void> {
  const child = spawn('docker', ['save', ...refs], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [code] = await Promise.all([exited(child), pipeline(child.stdout!, createGzip(), sink), alongside]);
  if (code !== 0) throw new Error(`docker save exited ${code}`);
}

async function load(source: Readable): Promise<void> {
  const child = spawn('docker', ['load'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exit = exited(child);
  await pipeline(source, createGunzip(), child.stdin!);
  const code = await exit;
  if (code !== 0) throw new Error(`docker load exited ${code}`);
}

async function withRegistry<T>(s: RegistryConfig, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'microrun-docker-'));
  const env = { DOCKER_CONFIG: dir };
  try {
    if (s.username) {
      await run(['login', s.registry, '-u', s.username, '--password-stdin'], { input: s.password, env, redact: [s.password] });
    }
    return await fn(env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function guarded<T>(kind: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AgentError) throw e;
    throw new AgentError('STORAGE_FAILED', { kind });
  }
}

export async function imagesPresent(images: Record<string, string>): Promise<boolean> {
  for (const ref of Object.values(images)) {
    if ((await docker(['image', 'inspect', ref])).code !== 0) return false;
  }
  return true;
}

export function pinImages(env: string, sha: string, images: Record<string, string>): Promise<void> {
  return guarded('pin', async () => {
    for (const [svc, ref] of Object.entries(images)) await run(['tag', ref, pinRef(env, sha, svc)]);
  });
}

export function storeImages(s: StorageConfig, env: string, sha: string, images: Record<string, string>): Promise<void> {
  return guarded(s.kind, async () => {
    const refs = Object.values(images);
    if (s.kind === 'local') {
      const file = localFile(s.path, env, sha);
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await mkdir(join(s.path, env), { recursive: true });
      try {
        await save(refs, createWriteStream(tmp));
        await rename(tmp, file);
      } finally {
        await rm(tmp, { force: true });
      }
    } else if (s.kind === 's3') {
      const client = s3Client(s);
      const Key = s3Key(s, env, sha);
      const body = new PassThrough();
      try {
        const upload = new Upload({ client, params: { Bucket: s.bucket, Key, Body: body } });
        await save(refs, body, upload.done()).catch(async (e: unknown) => {
          await client.send(new DeleteObjectCommand({ Bucket: s.bucket, Key })).catch(() => {});
          throw e;
        });
      } finally {
        client.destroy();
      }
    } else {
      await withRegistry(s, async (denv) => {
        for (const [svc, ref] of Object.entries(images)) {
          const remote = remoteRef(s, env, sha, svc);
          await run(['tag', ref, remote], { env: denv });
          await run(['push', remote], { env: denv, redact: [s.password] });
          await docker(['rmi', remote], { env: denv });
        }
      });
    }
  });
}

export async function fetchImages(s: StorageConfig, env: string, sha: string, images: Record<string, string>): Promise<void> {
  if (await imagesPresent(images)) return;
  return guarded(s.kind, async () => {
    if (s.kind === 'local') {
      await load(createReadStream(localFile(s.path, env, sha)));
    } else if (s.kind === 's3') {
      const client = s3Client(s);
      try {
        const obj = await client.send(new GetObjectCommand({ Bucket: s.bucket, Key: s3Key(s, env, sha) }));
        await load(obj.Body as Readable);
      } finally {
        client.destroy();
      }
    } else {
      await withRegistry(s, async (denv) => {
        for (const [svc, ref] of Object.entries(images)) {
          const remote = remoteRef(s, env, sha, svc);
          await run(['pull', remote], { env: denv, redact: [s.password] });
          await run(['tag', remote, ref], { env: denv });
          await docker(['rmi', remote], { env: denv });
        }
      });
    }
  });
}

export function deleteImages(s: StorageConfig, env: string, sha: string, images: Record<string, string>): Promise<void> {
  return guarded(s.kind, async () => {
    if (s.kind === 'local') {
      await rm(localFile(s.path, env, sha), { force: true });
    } else if (s.kind === 's3') {
      const client = s3Client(s);
      try {
        await client.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: s3Key(s, env, sha) }));
      } finally {
        client.destroy();
      }
    }
    for (const [svc, ref] of Object.entries(images)) {
      for (const target of [pinRef(env, sha, svc), ref]) {
        const r = await docker(['rmi', target]);
        if (r.code !== 0 && !/no such image|being used|is using/i.test(r.stderr)) throw new Error(r.stderr);
      }
    }
  });
}
