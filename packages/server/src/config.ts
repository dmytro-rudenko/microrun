export interface Config {
  adminUser: string;
  adminPassword: string;
  secretKey: Buffer;
  publicUrl: URL;
  dataDir: string;
  port: number;
  secureCookies: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const adminUser = required(env, 'MICRORUN_ADMIN_USER');
  const adminPassword = required(env, 'MICRORUN_ADMIN_PASSWORD');
  if (adminPassword.length < 12) throw new Error('MICRORUN_ADMIN_PASSWORD must be at least 12 characters');
  const secretKey = Buffer.from(required(env, 'MICRORUN_SECRET_KEY'), 'base64');
  if (secretKey.length !== 32) throw new Error('MICRORUN_SECRET_KEY must be 32 bytes in base64');
  const rawUrl = required(env, 'MICRORUN_PUBLIC_URL');
  if (!URL.canParse(rawUrl)) throw new Error('MICRORUN_PUBLIC_URL must be a valid URL');
  const publicUrl = new URL(rawUrl);
  const port = env.PORT ? Number(env.PORT) : 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  return {
    adminUser,
    adminPassword,
    secretKey,
    publicUrl,
    dataDir: env.MICRORUN_DATA_DIR || '/data',
    port,
    secureCookies: publicUrl.protocol === 'https:',
  };
}
