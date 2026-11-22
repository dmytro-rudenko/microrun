import { html, type Html } from './html.ts';

export const CONTROL =
  'block w-full rounded-md border border-line bg-field px-3.5 py-2.5 text-sm text-ink placeholder:text-mute focus:border-accent focus:outline-none focus:ring-4 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export const NAME_GATE = "this.form.querySelector('button[type=submit]').disabled=this.value!==this.dataset.name";

const attr = (name: string, v: string | number | undefined) => (v === undefined ? '' : html` ${name}="${v}"`);
const flag = (name: string, on: boolean | undefined) => (on ? ` ${name}` : '');

const LABEL_CAPS = 'text-xs font-semibold uppercase tracking-wider text-mute';
const LABEL_PLAIN = 'text-sm font-medium text-ink';

export const field = (p: { id: string; label: Html; control: Html; hint?: Html; error?: Html; caps?: boolean }): Html =>
  html`<div class="flex flex-col gap-1.5"><label for="${p.id}" class="${p.caps ? LABEL_CAPS : LABEL_PLAIN}">${p.label}</label>${p.control}${
    p.hint ? html`<p class="text-xs text-mute">${p.hint}</p>` : ''
  }${p.error ? html`<p class="text-xs text-prod">${p.error}</p>` : ''}</div>`;

export const input = (p: {
  name: string;
  id?: string;
  value?: string;
  type?: 'text' | 'password' | 'number' | 'url';
  required?: boolean;
  autocomplete?: string;
  placeholder?: string;
  testid?: string;
  invalid?: boolean;
  cls?: string;
  attrs?: Html;
}): Html => {
  const cls = CONTROL + (p.invalid ? ' border-prod' : '') + (p.cls ? ` ${p.cls}` : '');
  return html`<input name="${p.name}"${attr('value', p.value)} type="${p.type ?? 'text'}"${attr('id', p.id)}${flag('required', p.required)}${attr(
    'autocomplete',
    p.autocomplete,
  )}${attr('placeholder', p.placeholder)}${attr('data-testid', p.testid)} class="${cls}"${p.attrs}>`;
};

export const textarea = (p: { name: string; id?: string; value?: string; rows?: number }): Html =>
  html`<textarea name="${p.name}"${attr('id', p.id)} rows="${p.rows ?? 3}" class="${CONTROL} font-mono">${p.value ?? ''}</textarea>`;

const SELECT = `${CONTROL} pr-10`;

const SELECT_COMPACT =
  'rounded-md border border-line bg-field py-1.5 pl-2.5 pr-9 text-sm text-ink focus:border-accent focus:outline-none focus:ring-4 focus:ring-ring';

export const select = (p: {
  name: string;
  id?: string;
  options: { value: string; label: Html | string }[];
  current?: string;
  testid?: string;
  compact?: boolean;
  attrs?: Html;
}): Html =>
  html`<select name="${p.name}"${attr('id', p.id)}${attr('data-testid', p.testid)} class="${p.compact ? SELECT_COMPACT : SELECT}"${p.attrs}>${p.options.map(
    (o) => html`<option value="${o.value}"${flag('selected', o.value === p.current)}>${o.label}</option>`,
  )}</select>`;

export const checkbox = (p: { name: string; id?: string; checked: boolean; label?: Html; attrs?: Html }): Html => {
  const box = html`<input type="checkbox" name="${p.name}"${attr('id', p.id)}${flag('checked', p.checked)} class="size-4 rounded border-line bg-field text-accent checked:border-transparent checked:bg-current focus:ring-2 focus:ring-ring focus:ring-offset-0"${p.attrs}>`;
  return p.label ? html`<label class="inline-flex items-center gap-2 text-sm text-ink">${box}${p.label}</label>` : box;
};

const BUTTON =
  'inline-flex items-center justify-center rounded-md px-4 py-2.5 text-sm font-semibold focus:outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40';

const VARIANT: Record<'primary' | 'danger' | 'ghost', string> = {
  primary: 'bg-accent text-on-accent hover:opacity-90',
  danger: 'bg-prod text-white hover:opacity-90',
  ghost: 'border border-line bg-card text-ink hover:border-accent',
};

export const button = (p: {
  label: Html;
  variant?: 'primary' | 'danger' | 'ghost';
  type?: 'submit' | 'button';
  testid?: string;
  disabled?: boolean;
  block?: boolean;
  attrs?: Html;
}): Html =>
  html`<button type="${p.type ?? 'submit'}"${attr('data-testid', p.testid)} class="${p.block ? 'w-full ' : ''}${BUTTON} ${VARIANT[p.variant ?? 'primary']}"${flag(
    'disabled',
    p.disabled,
  )}${p.attrs}>${p.label}</button>`;

const TONE: Record<'error' | 'warn' | 'ok', string> = {
  error: 'border-prod bg-prod-soft',
  warn: 'border-warn bg-warn-soft',
  ok: 'border-ok bg-surface',
};

export const alert = (p: { tone: 'error' | 'warn' | 'ok'; body: Html; role?: 'alert' | 'status'; testid?: string; attrs?: Html }): Html =>
  html`<div${attr('role', p.role)}${attr('data-testid', p.testid)} class="rounded-lg border px-3 py-2 text-[13px] text-ink ${TONE[p.tone]}"${p.attrs}>${p.body}</div>`;

export const confirmName = (p: { label: Html; expected: string; name: string; testid: string; enabled?: boolean }): Html =>
  html`<label class="flex flex-col gap-1.5 text-xs text-mute">${p.label}<input type="text" name="${p.name}" data-testid="${p.testid}" data-name="${p.expected}" autocomplete="off" oninput="${NAME_GATE}" class="${CONTROL}"${flag(
    'disabled',
    p.enabled === false,
  )}></label>`;
