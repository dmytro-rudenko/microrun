const H = 3600e3, D = 24 * H, NOW = Date.now();

const SERVERS = [
  { id: 's-local', name: 'local', builtin: true, online: true, version: '0.1.0', proxy: 'external' },
  { id: 's-edge1', name: 'edge-fra-1', builtin: false, online: true, version: '0.1.0', proxy: 'bundled' },
  { id: 's-edge2', name: 'edge-waw-2', builtin: false, online: false, version: null, proxy: 'external' },
];

const ENVS = [
  {
    id: 'dev', name: 'dev', prod: false, branch: 'develop', serverId: 's-local', retention: { v: 3, u: 'days' },
    compose: 'shop-dev', composeDir: '/srv/shop-dev', db: 'postgres://db-dev/shop', storage: 'local · /var/lib/microrun/images',
    services: 'api · rolling, web · recreate, worker · recreate', schemaCheck: 'post_check', health: 60,
    releases: [
      { id: 'd5', sha: 'e41b07c', msg: 'feat(cart): save cart between sessions', author: 'olena', at: NOW - 2 * H, state: 'active', diff: [['add', '+ carts.saved_at']] },
      { id: 'd4', sha: '9c3d2aa', msg: 'fix(api): retry the payment webhook', author: 'taras', at: NOW - 9 * H, state: 'available', left: 0.85, diff: [] },
      { id: 'd3', sha: '51f0e9b', msg: 'chore: bump node to 24', author: 'olena', at: NOW - 1.4 * D, state: 'available', left: 0.53, diff: [] },
    ],
    ops: [
      { at: NOW - 2 * H, kind: 'Деплой', from: '9c3d2aa', to: 'e41b07c', who: 'CI · github-actions', ok: true, s: 41 },
      { at: NOW - 9 * H, kind: 'Деплой', from: '51f0e9b', to: '9c3d2aa', who: 'CI · github-actions', ok: true, s: 38 },
    ],
  },
  {
    id: 'stage', name: 'stage', prod: false, branch: 'release', serverId: 's-edge1', retention: { v: 7, u: 'days' },
    compose: 'shop-stage', composeDir: '/srv/shop-stage', db: 'postgres://db-stage/shop', storage: 'registry · ghcr.io/acme/shop',
    services: 'api · rolling, web · rolling, worker · recreate', schemaCheck: 'post_check', health: 90,
    releases: [
      { id: 's4', sha: '9c3d2aa', msg: 'fix(api): retry the payment webhook', author: 'taras', at: NOW - 6 * H, state: 'active', diff: [] },
      { id: 's3', sha: 'a7e1f30', msg: 'feat(search): filter by brand', author: 'iryna', at: NOW - 2 * D, state: 'available', left: 0.71, diff: [['add', '+ products.brand_id']] },
      { id: 's2', sha: 'b20c911', msg: 'refactor: split the orders module', author: 'taras', at: NOW - 3 * D, state: 'failed', diff: [['drop', '− users.email']] },
    ],
    ops: [
      { at: NOW - 6 * H, kind: 'Деплой', from: 'a7e1f30', to: '9c3d2aa', who: 'CI · github-actions', ok: true, s: 52 },
      { at: NOW - 3 * D, kind: 'Деплой', from: 'a7e1f30', to: 'b20c911', who: 'CI · github-actions', ok: false, s: 12, why: 'Dry-run відхилив деплой: колонку users.email видалено.' },
    ],
  },
  {
    id: 'production', name: 'production', prod: true, branch: 'main', serverId: 's-edge1', retention: { v: 14, u: 'days' },
    compose: 'shop', composeDir: '/srv/shop', db: 'postgres://db-prod/shop', storage: 's3 · s3://acme-releases/shop',
    services: 'api · rolling, web · rolling, worker · recreate', schemaCheck: 'dry_run', health: 120,
    releases: [
      { id: 'p6', sha: '9c3d2aa', msg: 'fix(api): retry the payment webhook', author: 'taras', at: NOW - 3 * H, state: 'active', diff: [] },
      { id: 'p5', sha: 'a7e1f30', msg: 'feat(search): filter by brand', author: 'iryna', at: NOW - 1.5 * D, state: 'available', left: 0.89, diff: [['add', '+ products.brand_id']] },
      { id: 'p4', sha: '3f88d01', msg: 'feat(checkout): Apple Pay', author: 'olena', at: NOW - 4 * D, state: 'available', left: 0.71, diff: [['add', '+ payments.wallet']] },
      { id: 'p3', sha: 'c51aa74', msg: 'feat(orders): bulk export to CSV', author: 'iryna', at: NOW - 6 * D, state: 'blocked', diff: [['add', '+ exports (таблиця)']] },
      { id: 'p2', sha: '0de4b6f', msg: 'chore: rotate the session secret', author: 'taras', at: NOW - 19 * D, state: 'expired', diff: [] },
    ],
    ops: [
      { at: NOW - 3 * H, kind: 'Деплой', from: 'a7e1f30', to: '9c3d2aa', who: 'CI · github-actions', ok: true, s: 63 },
      { at: NOW - 1.5 * D, kind: 'Деплой', from: '3f88d01', to: 'a7e1f30', who: 'CI · github-actions', ok: true, s: 58 },
      { at: NOW - 5 * D, kind: 'Відкат', from: 'c51aa74', to: '3f88d01', who: 'адмін', ok: true, s: 19 },
      { at: NOW - 5 * D + 20 * 60e3, kind: 'Прибирання', from: 'c51aa74', to: 'c51aa74', who: 'адмін', ok: true, s: 4, why: 'exports_table: очікувалось 1 204, видалено 1 204' },
      { at: NOW - 6 * D, kind: 'Деплой', from: '3f88d01', to: 'c51aa74', who: 'CI · github-actions', ok: true, s: 61 },
      { at: NOW - 12 * D, kind: 'Деплой', from: '0de4b6f', to: '3f88d01', who: 'CI · github-actions', ok: false, s: 120, why: 'api: healthcheck не пройшов за 120 с' },
    ],
  },
];
