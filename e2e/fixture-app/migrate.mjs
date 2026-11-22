import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
const [command, ...args] = process.argv.slice(2);

async function expand() {
  await sql`create table if not exists schema_migrations(name text primary key)`;
  const applied = new Set((await sql`select name from schema_migrations`).map(r => r.name));
  const files = (await readdir(new URL('./migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
    await sql.begin(async tx => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations(name) values (${file})`;
    });
    console.log(`applied ${file}`);
  }
}

async function promoCount() {
  const [{ exists }] = await sql`select to_regclass('public.notifications') is not null as exists`;
  if (!exists) return 0;
  const [{ count }] = await sql`select count(*)::int as count from notifications where type = 'promo' and created_at >= ${process.env.MICRORUN_DEPLOYED_AT}`;
  return count;
}

async function cleanup() {
  if (args.includes('--dry-run')) {
    console.log('counting promo notifications');
    console.log(JSON.stringify({ rule: 'promo-notifications', description: 'Promo notifications created by v2', count: await promoCount() }));
    return;
  }
  const rules = (args.find(a => a.startsWith('--rules=')) ?? '--rules=').slice('--rules='.length).split(',').filter(Boolean);
  if (args.includes('--apply') && rules.includes('promo-notifications')) {
    const deleted = await sql`delete from notifications where type = 'promo' and created_at >= ${process.env.MICRORUN_DEPLOYED_AT}`;
    console.log(JSON.stringify({ rule: 'promo-notifications', deleted: deleted.count }));
  }
}

try {
  if (command === 'expand') await expand();
  else if (command === 'contract') console.log('nothing to contract');
  else if (command === 'cleanup') await cleanup();
  else { console.error(`unknown command ${command}`); process.exitCode = 2; }
} finally {
  await sql.end();
}
