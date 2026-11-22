import core from './catalogs/core.ts';
import settings from './catalogs/settings.ts';
import ui from './catalogs/ui.ts';

export const LANGS = ['uk', 'en', 'de', 'fr', 'es', 'pt-BR', 'pl', 'zh-CN'] as const;
export type Lang = (typeof LANGS)[number];
export type Msg = string | { one?: string; few?: string; many?: string; other: string };
export type Catalog = Record<Lang, Record<string, Msg>>;

export const LANG_NAMES: Record<Lang, string> = {
  uk: 'Українська',
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  pl: 'Polski',
  'zh-CN': '简体中文',
};

export function isLang(x: unknown): x is Lang {
  return typeof x === 'string' && (LANGS as readonly string[]).includes(x);
}

function matchTag(tag: string): Lang | undefined {
  const lower = tag.toLowerCase();
  const exact = LANGS.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const primary = lower.split('-')[0];
  return LANGS.find((l) => l.split('-')[0]!.toLowerCase() === primary);
}

export function negotiate(cookie: string | undefined, acceptLanguage: string | undefined): Lang {
  if (isLang(cookie)) return cookie;
  const entries = (acceptLanguage ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.split(';');
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter((e) => e.tag && e.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of entries) {
    const lang = matchTag(tag);
    if (lang) return lang;
  }
  return 'en';
}

export function fromEnvLocale(env: { LC_ALL?: string; LANG?: string }, flag?: string): Lang {
  const raw = flag || env.LC_ALL || env.LANG || '';
  const tag = raw.split(/[.@]/)[0]!.replace('_', '-');
  return negotiate(undefined, tag);
}

const merged = {} as Catalog;
for (const lang of LANGS) merged[lang] = { ...core[lang], ...ui[lang], ...settings[lang] };

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v: string | number) => String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]!);

export interface I18n {
  lang: Lang;
  t(key: string, params?: Record<string, string | number>): string;
  num(n: number): string;
  unit(n: number, u: 'second' | 'minute' | 'hour' | 'day'): string;
  date(ts: number): string;
  ago(ts: number, now: number): string;
  left(ms: number): string;
}

export function i18n(lang: Lang): I18n {
  const plural = new Intl.PluralRules(lang);
  const numberFormat = new Intl.NumberFormat(lang);
  const num = (n: number) => numberFormat.format(n);
  const unit = (n: number, u: 'second' | 'minute' | 'hour' | 'day') =>
    new Intl.NumberFormat(lang, { style: 'unit', unit: u, unitDisplay: 'long' }).format(n);

  const t = (key: string, params: Record<string, string | number> = {}) => {
    let msg = merged[lang][key] ?? merged.en[key] ?? key;
    if (typeof msg === 'object') msg = (msg as Record<string, string | undefined>)[plural.select(Number(params.n))] ?? msg.other;
    return msg.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = params[k];
      return esc(k === 'n' && typeof v === 'number' ? num(v) : (v ?? ''));
    });
  };

  const date = (ts: number) =>
    new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(ts);

  const ago = (ts: number, now: number) => {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    const s = (ts - now) / 1e3;
    if (Math.abs(s) < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (Math.abs(s) < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
  };

  const left = (ms: number) => {
    if (ms < 36e5) return unit(Math.max(1, Math.ceil(ms / 60e3)), 'minute');
    const d = Math.floor(ms / 864e5);
    const h = Math.floor((ms % 864e5) / 36e5);
    if (d === 0) return unit(h, 'hour');
    return h ? `${unit(d, 'day')} ${unit(h, 'hour')}` : unit(d, 'day');
  };

  return { lang, t, num, unit, date, ago, left };
}

export function allKeys(): Record<Lang, string[]> {
  const out = {} as Record<Lang, string[]>;
  for (const lang of LANGS) out[lang] = Object.keys(merged[lang]);
  return out;
}
