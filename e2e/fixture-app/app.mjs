import http from 'node:http';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL);
const version = process.env.APP_VERSION;
const writesNickname = version === 'v2' || version === 'v3';

const readBody = req => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', c => { data += c; });
  req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  req.on('error', reject);
});

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') return send(res, 200, { ok: true });
    if (req.url === '/version') return send(res, 200, { version });
    if (req.url === '/users' && req.method === 'GET') return send(res, 200, await sql`select * from users order by id`);
    if (req.url === '/users' && req.method === 'POST') {
      const { name, email } = await readBody(req);
      const [row] = writesNickname
        ? await sql`insert into users(name, email, nickname) values (${name}, ${email}, ${name + '!'}) returning *`
        : await sql`insert into users(name, email) values (${name}, ${email}) returning *`;
      return send(res, 201, row);
    }
    if (req.url === '/login' && req.method === 'POST') {
      if (version === 'v2') {
        const rows = Array.from({ length: 50 }, () => ({ type: 'promo' }));
        await sql`insert into notifications ${sql(rows, 'type')}`;
      }
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
}).listen(3000);
