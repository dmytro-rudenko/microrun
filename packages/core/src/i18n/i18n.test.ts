import { describe, expect, test } from 'vitest';
import { LANGS, LANG_NAMES, allKeys, codeMessage, codePlain, fromEnvLocale, i18n, isLang, negotiate, webLang, type Lang } from './index.ts';

describe('isLang and LANG_NAMES', () => {
  test('LANGS lists the eight supported languages in order', () => {
    expect([...LANGS]).toEqual(['en', 'uk', 'de', 'fr', 'es', 'pt-BR', 'pl', 'zh-CN']);
  });

  test('isLang accepts supported tags and rejects everything else', () => {
    expect(isLang('pt-BR')).toBe(true);
    expect(isLang('uk')).toBe(true);
    expect(isLang('pt')).toBe(false);
    expect(isLang('../')).toBe(false);
    expect(isLang(undefined)).toBe(false);
    expect(isLang(42)).toBe(false);
  });

  test('LANG_NAMES has a non-empty name for every language', () => {
    for (const lang of LANGS) expect(LANG_NAMES[lang].length).toBeGreaterThan(0);
  });
});

describe('negotiate', () => {
  test('a valid cookie wins over Accept-Language', () => {
    expect(negotiate('de', 'pl-PL,pl;q=0.9')).toBe('de');
  });

  test('an invalid cookie falls through to Accept-Language', () => {
    expect(negotiate('xx', 'pl-PL,pl;q=0.9')).toBe('pl');
  });

  test('a path-like cookie with no header falls back to en', () => {
    expect(negotiate('../', undefined)).toBe('en');
  });

  test('an exact tag is matched', () => {
    expect(negotiate(undefined, 'pt-BR')).toBe('pt-BR');
    expect(negotiate(undefined, 'zh-CN,en;q=0.5')).toBe('zh-CN');
  });

  test('the primary subtag maps to the supported regional language', () => {
    expect(negotiate(undefined, 'pt')).toBe('pt-BR');
    expect(negotiate(undefined, 'zh')).toBe('zh-CN');
    expect(negotiate(undefined, 'fr-CA,fr;q=0.9')).toBe('fr');
  });

  test('unsupported entries are skipped until a supported one appears', () => {
    expect(negotiate(undefined, 'xx-YY,de;q=0.5')).toBe('de');
  });

  test('nothing usable falls back to en', () => {
    expect(negotiate(undefined, undefined)).toBe('en');
    expect(negotiate(undefined, '')).toBe('en');
    expect(negotiate(undefined, 'xx,yy;q=0.4')).toBe('en');
  });
});

describe('fromEnvLocale', () => {
  test('LANG is parsed down to the language', () => {
    expect(fromEnvLocale({ LANG: 'uk_UA.UTF-8' })).toBe('uk');
    expect(fromEnvLocale({ LANG: 'pt_BR.UTF-8' })).toBe('pt-BR');
    expect(fromEnvLocale({ LANG: 'zh_CN.UTF-8' })).toBe('zh-CN');
  });

  test('LC_ALL wins over LANG', () => {
    expect(fromEnvLocale({ LC_ALL: 'de_DE.UTF-8', LANG: 'uk_UA.UTF-8' })).toBe('de');
  });

  test('the flag wins over the environment', () => {
    expect(fromEnvLocale({ LC_ALL: 'de_DE.UTF-8', LANG: 'uk_UA.UTF-8' }, 'fr')).toBe('fr');
  });

  test('missing or unsupported locale falls back to en', () => {
    expect(fromEnvLocale({})).toBe('en');
    expect(fromEnvLocale({ LANG: 'C' })).toBe('en');
    expect(fromEnvLocale({ LANG: 'POSIX' })).toBe('en');
  });
});

describe('t', () => {
  test('uk codes.COMMIT_BLOCKED is the catalog text with params substituted', () => {
    expect(i18n('uk').t('codes.COMMIT_BLOCKED', { sha: 'abc1234', env: 'prod', at: '10:00' })).toBe(
      'Коміт abc1234 заблоковано на prod: з нього виконано відкат 10:00. Зробіть новий коміт із виправленням і задеплойте його.',
    );
  });

  test('en codes.COMMIT_BLOCKED is the catalog text with params substituted', () => {
    expect(i18n('en').t('codes.COMMIT_BLOCKED', { sha: 'abc1234', env: 'prod', at: '10:00' })).toBe(
      'Commit abc1234 is blocked on prod: it was rolled back 10:00. Push a new commit with a fix and deploy it.',
    );
  });

  test('params are HTML-escaped', () => {
    const out = i18n('uk').t('codes.COMMIT_BLOCKED', { sha: '<b>', env: 'p', at: 'x' });
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('<b>');
  });

  test('all five special characters are escaped', () => {
    const out = i18n('en').t('cli.step', { step: `&<>"'` });
    expect(out).toBe('&amp;&lt;&gt;&quot;&#39;…');
  });

  test('text substitutes params without HTML-escaping them', () => {
    const en = i18n('en');
    expect(en.text('cli.step', { step: `&<>"'` })).toBe(`&<>"'…`);
    expect(en.text('codes.BRANCH_MISMATCH', { branch: "fix/o'neil&co", env: 'prod', expected: 'main' })).toBe(
      "Branch fix/o'neil&co cannot be deployed to prod: this environment deploys main.",
    );
  });

  test('text pluralises and formats n like t', () => {
    for (const lang of LANGS) {
      const i = i18n(lang);
      for (const n of [1, 3, 5, 1234]) expect(i.text('env.available', { n })).toBe(i.t('env.available', { n }));
    }
  });

  test('an unknown key returns the key itself', () => {
    expect(i18n('de').t('no.such.key')).toBe('no.such.key');
  });

  test('cli.busy.wait carries its param', () => {
    expect(i18n('en').t('cli.busy.wait', { s: 5 })).toBe('Environment is busy, retrying in 5…');
  });

  test('common keys resolve to text rather than the key', () => {
    for (const k of ['close', 'cancel', 'confirm', 'save', 'retry', 'yes', 'no']) {
      for (const lang of LANGS) {
        const out = i18n(lang).t(`common.${k}`);
        expect(out).not.toBe(`common.${k}`);
        expect(out.length).toBeGreaterThan(0);
      }
    }
  });

  test('cli keys resolve to text in every language', () => {
    for (const k of ['cli.step', 'cli.done.ok', 'cli.done.failed', 'cli.done.rejected', 'cli.busy.wait', 'cli.unreachable', 'cli.usage']) {
      for (const lang of LANGS) expect(i18n(lang).t(k, { step: 'x', s: 1 })).not.toBe(k);
    }
  });
});

describe('renamed texts', () => {
  const cases: { key: string; params?: Record<string, string>; expected: Partial<Record<Lang, string>> }[] = [
    {
      key: 'approve.expires',
      params: { list: '1111111, 2222222' },
      expected: {
        uk: 'Після схвалення ці релізи втратять можливість відкату: 1111111, 2222222.',
        en: 'After approval, these releases can no longer be rolled back to: 1111111, 2222222.',
        de: 'Nach der Freigabe ist kein Rollback mehr auf diese Releases möglich: 1111111, 2222222.',
        fr: 'Après approbation, il ne sera plus possible de revenir à ces releases : 1111111, 2222222.',
        es: 'Tras la aprobación, ya no se podrá volver a estos releases: 1111111, 2222222.',
        'pt-BR': 'Após a aprovação, não será mais possível voltar para estas releases: 1111111, 2222222.',
        pl: 'Po zatwierdzeniu nie będzie można wycofać się do tych wydań: 1111111, 2222222.',
        'zh-CN': '批准后将无法再回滚到这些版本：1111111, 2222222。',
      },
    },
    {
      key: 'state.expired',
      expected: {
        uk: 'Відкат закрито',
        en: 'Rollback closed',
        de: 'Rollback geschlossen',
        fr: 'Rollback fermé',
        es: 'Rollback cerrado',
        'pt-BR': 'Rollback encerrado',
        pl: 'Wycofanie zamknięte',
        'zh-CN': '回滚已关闭',
      },
    },
    {
      key: 'state.failed',
      expected: {
        uk: 'Невдалий деплой',
        en: 'Deploy failed',
        de: 'Deploy fehlgeschlagen',
        fr: 'Échec du déploiement',
        es: 'Despliegue fallido',
        'pt-BR': 'Falha na implantação',
        pl: 'Wdrożenie nieudane',
        'zh-CN': '部署失败',
      },
    },
    {
      key: 'codes.COMMIT_EXPIRED',
      params: { sha: 'abc1234', env: 'production' },
      expected: {
        uk: 'Коміт abc1234 не можна задеплоїти повторно на production: вікно відкату його релізу закрито. Зробіть новий коміт і задеплойте його.',
        en: 'Commit abc1234 cannot be redeployed on production: the rollback window of its release has closed. Push a new commit and deploy it.',
        de: 'Commit abc1234 kann auf production nicht erneut deployt werden: Das Rollback-Fenster seines Releases ist geschlossen. Pushen Sie einen neuen Commit und deployen Sie ihn.',
        fr: 'Le commit abc1234 ne peut pas être redéployé sur production : la fenêtre de rollback de sa release est fermée. Poussez un nouveau commit et déployez-le.',
        es: 'El commit abc1234 no se puede volver a desplegar en production: la ventana de rollback de su release está cerrada. Suba un nuevo commit y despliéguelo.',
        'pt-BR': 'O commit abc1234 não pode ser implantado novamente em production: a janela de rollback da release foi encerrada. Envie um novo commit e implante-o.',
        pl: 'Commitu abc1234 nie można ponownie wdrożyć na production: okno wycofania jego wydania zostało zamknięte. Wypchnij nowy commit i wdróż go.',
        'zh-CN': '提交 abc1234 无法在 production 上重新部署：其版本的回滚窗口已关闭。请推送新提交并部署。',
      },
    },
    {
      key: 'col.window',
      expected: {
        uk: 'Залишилось для відкату',
        en: 'Rollback time left',
        de: 'Rollback noch möglich',
        fr: 'Temps de rollback restant',
        es: 'Tiempo restante de rollback',
        'pt-BR': 'Tempo restante de rollback',
        pl: 'Czas na wycofanie',
        'zh-CN': '剩余回滚时间',
      },
    },
    {
      key: 'env.window',
      params: { w: '5d' },
      expected: {
        uk: 'вікно відкату 5d',
        en: 'rollback window 5d',
        de: 'Rollback-Fenster 5d',
        fr: 'fenêtre de rollback 5d',
        es: 'ventana de rollback 5d',
        'pt-BR': 'janela de rollback 5d',
        pl: 'okno wycofania 5d',
        'zh-CN': '回滚窗口 5d',
      },
    },
    {
      key: 'kind.expire',
      expected: {
        uk: 'Закриття вікна відкату',
        en: 'Rollback window closed',
        de: 'Rollback-Fenster geschlossen',
        fr: 'Fenêtre de rollback fermée',
        es: 'Ventana de rollback cerrada',
        'pt-BR': 'Janela de rollback encerrada',
        pl: 'Zamknięcie okna wycofania',
        'zh-CN': '回滚窗口关闭',
      },
    },
    { key: 'kind.approve', expected: { uk: 'Схвалення' } },
    {
      key: 'note.fail',
      params: { col: 'users.email' },
      expected: {
        uk: 'Dry-run відхилив деплой: міграція видаляє колонку users.email. Справжню базу не змінено.',
        en: 'Dry-run rejected the deploy: the migration drops column users.email. The real database was not touched.',
        de: 'Dry-Run hat den Deploy abgelehnt: Die Migration entfernt die Spalte users.email. Die echte Datenbank blieb unverändert.',
        fr: 'Le dry-run a refusé le déploiement : la migration supprime la colonne users.email. La vraie base n’a pas été modifiée.',
        es: 'El dry-run rechazó el despliegue: la migración elimina la columna users.email. La base real no se tocó.',
        'pt-BR': 'O dry-run recusou o deploy: a migração remove a coluna users.email. O banco real não foi alterado.',
        pl: 'Dry-run odrzucił wdrożenie: migracja usuwa kolumnę users.email. Prawdziwa baza nie została zmieniona.',
        'zh-CN': '预演拒绝了部署：迁移会删除列 users.email。真实数据库未被修改。',
      },
    },
    {
      key: 'reason.dryRun',
      params: { col: 'users.email' },
      expected: {
        uk: 'Dry-run: руйнівна зміна схеми — міграція видаляє users.email.',
        en: 'Dry-run: destructive schema change — the migration drops users.email.',
        de: 'Dry-Run: destruktive Schemaänderung — die Migration entfernt users.email.',
        fr: 'Dry-run : changement de schéma destructif — la migration supprime users.email.',
        es: 'Dry-run: cambio de esquema destructivo — la migración elimina users.email.',
        'pt-BR': 'Dry-run: mudança destrutiva de schema — a migração remove users.email.',
        pl: 'Dry-run: destrukcyjna zmiana schematu — migracja usuwa users.email.',
        'zh-CN': '预演：破坏性结构变更 — 迁移会删除 users.email。',
      },
    },
    { key: 'login.error', expected: { uk: 'Неправильний логін або пароль.' } },
    {
      key: 'settings.f.health_timeout_s',
      expected: {
        uk: 'Тайм-аут healthcheck (с)',
        en: 'Healthcheck timeout (seconds)',
        de: 'Healthcheck-Timeout (Sekunden)',
        fr: 'Délai du healthcheck (s)',
        'zh-CN': 'healthcheck 超时（秒）',
      },
    },
  ];

  describe.each(LANGS)('%s', (lang) => {
    test.each(cases.filter(({ expected }) => expected[lang] !== undefined))('$key', ({ key, params, expected }) => {
      expect(i18n(lang).t(key, params)).toBe(expected[lang]);
    });

    test.each(['closeWindow.go', 'closeWindow.text'])('omits %s', (key) => {
      expect(allKeys()[lang]).not.toContain(key);
    });
  });
});

describe('number, unit and duration formatting', () => {
  test('num follows the language locale', () => {
    expect(i18n('en').num(1234567)).toBe('1,234,567');
    expect(i18n('de').num(1234567)).toBe('1.234.567');
  });

  test('uk unit uses the plural form for 5 days', () => {
    expect(i18n('uk').unit(5, 'day')).toBe('5 днів');
  });

  test('pl unit uses the Polish word for 13 seconds', () => {
    expect(i18n('pl').unit(13, 'second')).toContain('sekund');
  });

  test('left shows whole days', () => {
    expect(i18n('uk').left(87 * 864e5)).toBe('87 днів');
  });

  test('left drops zero hours', () => {
    expect(i18n('en').left(2 * 864e5)).toBe('2 days');
  });

  test('left joins days and hours', () => {
    expect(i18n('en').left(864e5 + 3 * 36e5)).toBe('1 day 3 hours');
  });

  test('left below a day shows hours only', () => {
    expect(i18n('en').left(5 * 36e5)).toBe('5 hours');
  });

  test('left under one hour shows minutes', () => {
    expect(i18n('uk').left(25 * 60e3)).toBe('25 хвилин');
    expect(i18n('en').left(59 * 60e3)).toBe('59 minutes');
  });

  test('left under one minute shows at least one minute', () => {
    expect(i18n('en').left(30e3)).toBe('1 minute');
    expect(i18n('en').left(0)).toBe('1 minute');
  });

  test('left at exactly one hour shows hours', () => {
    expect(i18n('en').left(36e5)).toBe('1 hour');
  });

  test('lang is exposed on the instance', () => {
    expect(i18n('pt-BR').lang).toBe('pt-BR');
  });
});

describe('date and ago', () => {
  test('date renders in UTC', () => {
    expect(i18n('en').date(Date.UTC(2026, 10, 22, 10, 0))).toMatch(/10:00/);
  });

  test('ago renders hours in the past', () => {
    const now = Date.UTC(2026, 10, 22, 10, 0);
    expect(i18n('en').ago(now - 3 * 36e5, now)).toBe('3 hours ago');
  });

  test('ago renders days in the future', () => {
    const now = Date.UTC(2026, 10, 22, 10, 0);
    expect(i18n('en').ago(now + 2 * 864e5, now)).toBe('in 2 days');
  });
});

describe('codeMessage', () => {
  test('formats a numeric at as a human date', () => {
    const en = i18n('en');
    const at = Date.UTC(2026, 10, 22, 12, 9);
    const m = codeMessage(en, 'COMMIT_BLOCKED', { sha: 'bbbbbbb', env: 'production', at });
    expect(m).toBe(en.t('codes.COMMIT_BLOCKED', { sha: 'bbbbbbb', env: 'production', at: en.date(at) }));
    expect(m).toContain('Nov 22');
    expect(m).not.toContain(String(at));
  });

  test('passes other params through unchanged', () => {
    const uk = i18n('uk');
    expect(codeMessage(uk, 'ENV_BUSY', { env: 'staging' })).toBe(uk.t('codes.ENV_BUSY', { env: 'staging' }));
  });
});

describe('codePlain', () => {
  test('keeps quotes and ampersands of params as plain text', () => {
    const en = i18n('en');
    const m = codePlain(en, 'ENV_BUSY', { env: "o'neil & co" });
    expect(m).toBe("o'neil & co is busy with another operation. Try again shortly.");
    expect(codeMessage(en, 'ENV_BUSY', { env: "o'neil & co" })).toContain('o&#39;neil &amp; co');
  });

  test('formats a numeric at as a human date', () => {
    const en = i18n('en');
    const at = Date.UTC(2026, 10, 22, 12, 9);
    expect(codePlain(en, 'COMMIT_BLOCKED', { sha: 'bbbbbbb', env: 'production', at })).toBe(
      codeMessage(en, 'COMMIT_BLOCKED', { sha: 'bbbbbbb', env: 'production', at }),
    );
  });
});

describe('codes.AGENT_ERROR', () => {
  test('en reads "The agent failed: {reason}"', () => {
    expect(codePlain(i18n('en'), 'AGENT_ERROR', { reason: 'socket hang up' })).toBe('The agent failed: socket hang up');
  });

  test('every language has its own translation carrying the reason', () => {
    const en = i18n('en').t('codes.AGENT_ERROR', { reason: 'R' });
    for (const lang of LANGS) {
      const out = i18n(lang).t('codes.AGENT_ERROR', { reason: 'R' });
      expect(out).not.toBe('codes.AGENT_ERROR');
      expect(out).toContain('R');
      if (lang !== 'en') expect(out, lang).not.toBe(en);
    }
  });
});

describe('allKeys', () => {
  test('every language has exactly the keys of en', () => {
    const keys = allKeys();
    const en = [...keys.en].sort();
    for (const lang of LANGS) expect([...keys[lang]].sort()).toEqual(en);
  });

  test('en contains the 20 result codes, common and cli keys', () => {
    const en = allKeys().en;
    expect(en.filter((k) => k.startsWith('codes.'))).toHaveLength(20);
    expect(en).toContain('codes.COMMIT_BLOCKED');
    for (const k of ['close', 'cancel', 'confirm', 'save', 'retry', 'yes', 'no']) expect(en).toContain(`common.${k}`);
    for (const k of ['cli.step', 'cli.done.ok', 'cli.done.failed', 'cli.done.rejected', 'cli.busy.wait', 'cli.unreachable', 'cli.usage']) {
      expect(en).toContain(k);
    }
  });
});

describe('webLang', () => {
  test('takes a supported cookie and defaults to en otherwise', () => {
    expect(webLang('uk')).toBe('uk');
    expect(webLang(undefined)).toBe('en');
    expect(webLang('xx')).toBe('en');
    expect(webLang('../')).toBe('en');
  });
});

test('the UI polish keys resolve in every language', () => {
  const keys = [
    'login.tagline', 'login.subline', 'login.showPassword', 'settings.delete', 'settings.confirmName',
    'settings.servers.deleteTitle', 'settings.servers.deleteBody', 'settings.servers.deleteBuiltin', 'settings.servers.deleteHasEnvs',
    'settings.env.dangerZone', 'settings.env.deleteTitle', 'settings.env.deleteBody', 'settings.env.deleteBusy',
  ];
  for (const lang of LANGS) for (const k of keys) expect(i18n(lang).t(k, { name: 'x', n: 1 }), `${lang} ${k}`).not.toBe(k);
});
