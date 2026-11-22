window.MR = (() => {
  const now = new Date('2026-11-22T15:00:00Z').getTime();
  const h = 3600e3, d = 24 * h;
  const envs = [
    {
      id: 'production', name: 'production', branch: 'prod', prod: true,
      server: 'app-1.hetzner (вбудований агент)', agentOnline: true,
      compose: 'shop', services: [{ name: 'web', strategy: 'rolling' }, { name: 'worker', strategy: 'recreate' }],
      db: 'postgres 17 · shop_prod', retention: 90 * d, retentionLabel: '3 місяці',
      storage: 'S3 · s3.eu-central-1/shop-releases', markerOk: true,
      releases: [
        { sha: 'f3a91c2', msg: 'Промо-нотифікації для нових користувачів', author: 'Олена К.', at: now - 2 * h, state: 'active',
          diff: [{ k: 'add', t: 'notifications.campaign_id uuid NULL' }, { k: 'add', t: 'INDEX notifications(campaign_id)' }], cleanup: true },
        { sha: '9b07e4d', msg: 'Фікс підрахунку знижки в кошику', author: 'Максим Т.', at: now - 3 * d, superseded: now - 2 * h, state: 'available',
          diff: [], cleanup: false },
        { sha: '51cc0aa', msg: 'Новий екран профілю: аватар і біо', author: 'Олена К.', at: now - 9 * d, superseded: now - 3 * d, state: 'available',
          diff: [{ k: 'add', t: 'users.bio text NULL' }, { k: 'add', t: 'users.avatar_url text NULL' }], cleanup: false },
        { sha: 'c4410be', msg: 'Пошук по замовленнях (зламав пагінацію)', author: 'Ігор П.', at: now - 10 * d, superseded: now - 9 * d, state: 'blocked',
          blockedNote: 'Відкат 13.11 о 18:42 → 51cc0aa', diff: [{ k: 'add', t: 'INDEX orders(customer_email)' }], cleanup: false },
        { sha: '7e2d913', msg: 'Оплата частинами', author: 'Максим Т.', at: now - 41 * d, superseded: now - 10 * d, state: 'available',
          diff: [{ k: 'add', t: 'TABLE installments' }, { k: 'warn', t: 'UNIQUE INDEX payments(external_id)' }], cleanup: false },
        { sha: '0aa1b55', msg: 'Міграція на нову платіжну схему', author: 'Ігор П.', at: now - 120 * d, superseded: now - 95 * d, state: 'expired',
          diff: [], cleanup: false },
      ],
    },
    {
      id: 'stage', name: 'stage', branch: 'stage', prod: false,
      server: 'stage-1.hetzner (агент microrun 1.0.0)', agentOnline: true,
      compose: 'shop-stage', services: [{ name: 'web', strategy: 'rolling' }, { name: 'worker', strategy: 'recreate' }],
      db: 'postgres 17 · shop_stage', retention: 14 * d, retentionLabel: '2 тижні',
      storage: 'Docker registry · registry.shop.ua/releases', markerOk: false,
      markerWarn: 'Сервіс worker підключений до бази з маркером оточення «dev» (DATABASE_URL → postgres-dev:5432/shop_dev). Деплой на stage заблоковано, доки це не виправлено.',
      releases: [
        { sha: 'a81f7c0', msg: 'Експорт замовлень у CSV', author: 'Ігор П.', at: now - 5 * h, state: 'active', diff: [{ k: 'add', t: 'TABLE exports' }], cleanup: true },
        { sha: 'f3a91c2', msg: 'Промо-нотифікації для нових користувачів', author: 'Олена К.', at: now - 1 * d, superseded: now - 5 * h, state: 'available', diff: [], cleanup: true },
        { sha: 'e19d002', msg: 'Перейменування поля phone', author: 'Максим Т.', at: now - 2 * d, state: 'failed',
          failNote: 'Dry-run відхилив деплой: колонку users.phone видалено (перейменування = видалення + додавання). Справжню базу не змінено.',
          diff: [{ k: 'drop', t: 'users.phone' }, { k: 'add', t: 'users.phone_number text NULL' }], cleanup: false },
      ],
    },
    {
      id: 'dev', name: 'dev', branch: 'dev', prod: false,
      server: 'app-1.hetzner (вбудований агент)', agentOnline: false,
      compose: 'shop-dev', services: [{ name: 'web', strategy: 'recreate' }],
      db: 'sqlite · /data/dev.db', retention: 3 * d, retentionLabel: '3 дні',
      storage: 'Локальний диск · /var/lib/microrun/releases', markerOk: true,
      releases: [
        { sha: '3be6aa1', msg: 'WIP: темна тема', author: 'Олена К.', at: now - 20 * 60e3, state: 'active', diff: [], cleanup: false },
      ],
    },
  ];
  const cleanupRules = [
    { rule: 'broken-notifications', description: 'Промо-нотифікації, створені f3a91c2 (дублікати при кожному вході)', count: 298412 },
    { rule: 'orphan-campaign-links', description: 'Посилання на кампанії без кампанії', count: 1207 },
    { rule: 'test-campaigns', description: 'Тестові кампанії, створені QA на production', count: 0 },
  ];
  const history = [
    { at: now - 2 * h, env: 'production', kind: 'deploy', from: '9b07e4d', to: 'f3a91c2', actor: 'ci: Олена К.', status: 'ok', dur: '41 с' },
    { at: now - 5 * h, env: 'stage', kind: 'deploy', from: 'f3a91c2', to: 'a81f7c0', actor: 'ci: Ігор П.', status: 'ok', dur: '38 с' },
    { at: now - 26 * h, env: 'stage', kind: 'deploy', from: 'c4410be', to: 'c4410be', actor: 'ci: Ігор П.', status: 'rejected', dur: '—',
      reason: 'Коміт c4410be заблоковано: з нього виконано відкат 13.11 о 18:42. Зробіть новий коміт із виправленням.' },
    { at: now - 2 * d, env: 'stage', kind: 'deploy', from: 'f3a91c2', to: 'e19d002', actor: 'ci: Максим Т.', status: 'failed', dur: '22 с',
      reason: 'Dry-run: деструктивна зміна схеми — видалено users.phone.' },
    { at: now - 3 * d, env: 'production', kind: 'deploy', from: '51cc0aa', to: '9b07e4d', actor: 'ci: Максим Т.', status: 'ok', dur: '44 с' },
    { at: now - 9 * d, env: 'production', kind: 'cleanup', from: 'c4410be', to: '—', actor: 'admin', status: 'ok', dur: '6 с',
      reason: 'search-cache-rows: прогноз 5 120, видалено 5 120' },
    { at: now - 9 * d, env: 'production', kind: 'rollback', from: 'c4410be', to: '51cc0aa', actor: 'admin', status: 'ok', dur: '19 с' },
    { at: now - 95 * d, env: 'production', kind: 'contract', from: '7e2d913', to: '—', actor: 'system', status: 'ok', dur: '3 с' },
  ];
  const fmtAgo = t => {
    const s = (now - t) / 1e3;
    if (s < 3600) return `${Math.round(s / 60)} хв тому`;
    if (s < 86400) return `${Math.round(s / 3600)} год тому`;
    return `${Math.round(s / 86400)} дн тому`;
  };
  const fmtDate = t => new Date(t).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
  const left = (env, r) => {
    if (r.state !== 'available') return null;
    const ms = r.superseded + env.retention - now;
    const days = Math.floor(ms / d), hrs = Math.floor((ms % d) / h);
    return { ms, label: days > 0 ? `${days} дн ${hrs} год` : `${hrs} год`, pct: Math.max(0, Math.min(100, (ms / env.retention) * 100)) };
  };
  const stateLabel = { active: 'Активний', available: 'Доступний', blocked: 'Заблокований', expired: 'Прострочений', failed: 'Не викатано' };
  const kindLabel = { deploy: 'Деплой', rollback: 'Відкат', cleanup: 'Прибирання', contract: 'Contract', expire: 'Закінчення вікна' };
  const statusLabel = { ok: 'Успішно', rejected: 'Відхилено', failed: 'Помилка' };
  const env = id => envs.find(e => e.id === id);
  const newerThan = (e, sha) => { const i = e.releases.findIndex(r => r.sha === sha); return e.releases.slice(0, i).filter(r => r.state === 'active' || r.state === 'available'); };
  const applyRollback = (e, sha) => {
    const t = e.releases.find(r => r.sha === sha);
    for (const r of newerThan(e, sha)) { r.state = 'blocked'; r.blockedNote = `Відкат 22.11 о 17:00 → ${sha}`; }
    t.state = 'active'; delete t.superseded;
  };
  return { applyRollback, now, envs, env, cleanupRules, history, fmtAgo, fmtDate, left, stateLabel, kindLabel, statusLabel, newerThan };
})();
