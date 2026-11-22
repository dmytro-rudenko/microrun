import { codeMessage, type I18n } from '@microrun/core/i18n';

export type Html = { __html: string };

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (v: unknown): string => String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const isHtml = (v: unknown): v is Html => typeof v === 'object' && v !== null && typeof (v as Html).__html === 'string';

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  return isHtml(v) ? v.__html : esc(v);
}

export function html(strings: TemplateStringsArray, ...vals: unknown[]): Html {
  return { __html: strings.reduce((out, s, k) => out + s + (k < vals.length ? render(vals[k]) : ''), '') };
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export const maskUrl = (u: string) =>
  u
    .replace(SCHEME.test(u) ? /^([a-z][a-z0-9+.-]*:\/\/[^/?#:@]*):.*@/is : /^([^\s/?#:@=]+):.*@/s, '$1:***@')
    .replace(/(^|[\s?&;])(password)=[^\s&;#]*/gi, '$1$2=***');

export const raw = (s: string): Html => ({ __html: s });

export const tr = (i: I18n, key: string, params?: Record<string, string | number>): Html => raw(i.t(key, params));

export const codeText = (i: I18n, code: string, params: Record<string, string | number> = {}): Html => raw(codeMessage(i, code, params));
