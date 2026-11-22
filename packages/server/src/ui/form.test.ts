import { describe, expect, test } from 'vitest';
import { esc, raw } from './html.ts';
import { NAME_GATE, alert, button, checkbox, confirmName, field, input, select, textarea } from './form.ts';

const EVIL = '<img src=x onerror=alert(1)>';
const EVIL_ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';

describe('input', () => {
  test('escapes the value', () => {
    const out = input({ name: 'x', value: EVIL }).__html;
    expect(out).toContain(`value="${EVIL_ESCAPED}"`);
    expect(out).not.toContain('<img');
  });

  test('puts name as the first attribute', () => {
    expect(input({ name: 'x', id: 'i', type: 'password', value: 'v' }).__html).toMatch(/^<input name="x"/);
  });

  test('has no value attribute when value is omitted', () => {
    expect(input({ name: 'x' }).__html).not.toMatch(/\svalue=/);
  });
});

describe('field', () => {
  const control = raw('<input name="n" id="f">');
  const CAPS = 'uppercase';

  test('renders a label for the id with the label text, followed by the control', () => {
    const out = field({ id: 'f', label: raw('Name'), control }).__html;
    expect(out).toMatch(/<label for="f"[^>]*>Name<\/label><input name="n" id="f">/);
  });

  test('renders a hint paragraph only when a hint is given', () => {
    expect(field({ id: 'f', label: raw('Name'), control, hint: raw('Lowercase only') }).__html).toMatch(/<p[^>]*>Lowercase only<\/p>/);
    expect(field({ id: 'f', label: raw('Name'), control }).__html).not.toContain('<p');
  });

  test('renders an error paragraph only when an error is given', () => {
    expect(field({ id: 'f', label: raw('Name'), control, error: raw('Required') }).__html).toMatch(/<p[^>]*text-prod[^>]*>Required<\/p>/);
    expect(field({ id: 'f', label: raw('Name'), control }).__html).not.toContain('text-prod');
  });

  test('uses the caps label class only with caps:true', () => {
    const label = (out: string) => /<label[^>]*>/.exec(out)?.[0] ?? '';
    expect(label(field({ id: 'f', label: raw('Name'), control, caps: true }).__html)).toContain(CAPS);
    expect(label(field({ id: 'f', label: raw('Name'), control }).__html)).not.toContain(CAPS);
  });
});

describe('textarea', () => {
  test('escapes its value', () => {
    const out = textarea({ name: 't', value: EVIL }).__html;
    expect(out).toContain(`>${EVIL_ESCAPED}</textarea>`);
    expect(out).not.toContain('<img');
  });

  test('puts name as the first attribute', () => {
    expect(textarea({ name: 't', id: 'x', rows: 5 }).__html).toMatch(/^<textarea name="t"/);
  });

  test('uses rows 3 by default and the given rows otherwise', () => {
    expect(textarea({ name: 't' }).__html).toContain('rows="3"');
    expect(textarea({ name: 't', rows: 8 }).__html).toContain('rows="8"');
  });
});

describe('select', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ];

  test('starts with <select name="x"', () => {
    expect(select({ name: 'x', id: 's', options }).__html).toMatch(/^<select name="x"/);
  });

  test('marks the current option selected and no other', () => {
    const out = select({ name: 'x', options, current: 'b' }).__html;
    expect(out).toContain('<option value="b" selected>');
    expect(out).toContain('<option value="a">');
    expect(out.match(/selected/g)).toHaveLength(1);
  });
});

describe('button', () => {
  test('is a submit button by default', () => {
    expect(button({ label: raw('Go') }).__html).toContain('type="submit"');
  });

  test('carries the disabled attribute when disabled', () => {
    const out = button({ label: raw('Go'), disabled: true }).__html;
    expect(out).toMatch(/<button[^>]*\sdisabled[\s>]/);
  });

  test('has no disabled attribute by default', () => {
    expect(button({ label: raw('Go') }).__html).not.toMatch(/<button[^>]*\sdisabled[\s>]/);
  });
});

describe('alert', () => {
  test('emits role, then testid, then the error tone class', () => {
    const out = alert({ tone: 'error', role: 'alert', testid: 't', body: raw('boom') }).__html;
    expect(out).toMatch(/^<div role="alert" data-testid="t" class="[^"]*border-prod/);
    expect(out).toContain('boom');
  });
});

describe('confirmName', () => {
  test('carries the escaped expected name in data-name', () => {
    const out = confirmName({ label: raw('Type'), expected: EVIL, name: 'confirm', testid: 'c' }).__html;
    expect(out).toContain(`data-name="${EVIL_ESCAPED}"`);
    expect(out).not.toContain('<img');
  });

  test('gates the submit button with the escaped NAME_GATE', () => {
    const out = confirmName({ label: raw('Type'), expected: 'prod', name: 'confirm', testid: 'c' }).__html;
    expect(out).toContain(`oninput="${esc(NAME_GATE)}"`);
  });

  test('is disabled when enabled is false', () => {
    const out = confirmName({ label: raw('Type'), expected: 'prod', name: 'confirm', testid: 'c', enabled: false }).__html;
    expect(out).toMatch(/<input[^>]*\sdisabled[\s>]/);
  });

  test('is not disabled by default', () => {
    const out = confirmName({ label: raw('Type'), expected: 'prod', name: 'confirm', testid: 'c' }).__html;
    expect(out).not.toMatch(/<input[^>]*\sdisabled[\s>]/);
  });
});

describe('checkbox', () => {
  test('is checked when checked is true', () => {
    expect(checkbox({ name: 'x', checked: true }).__html).toMatch(/<input[^>]*\schecked[\s>]/);
  });

  test('is not checked when checked is false', () => {
    expect(checkbox({ name: 'x', checked: false }).__html).not.toMatch(/<input[^>]*\schecked[\s>]/);
  });
});
