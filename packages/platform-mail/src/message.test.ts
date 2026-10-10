import { describe, expect, it } from 'vitest';
import { MailSendError } from './errors';
import { MESSAGE_LIMITS, validateMessage, type EmailMessage } from './message';
import { sampleMessage } from './testing/conformance';

function reasonFor(overrides: Partial<EmailMessage>): string {
  try {
    validateMessage(sampleMessage(overrides));
  } catch (err) {
    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).code).toBe('invalid_message');
    return (err as MailSendError).message;
  }
  throw new Error('expected the message to be rejected');
}

describe('validateMessage', () => {
  it('normalises single addresses to arrays and fills the optional parts', () => {
    const v = validateMessage(sampleMessage({ to: 'a@example.test' }));
    expect(v.to).toEqual(['a@example.test']);
    expect(v.cc).toEqual([]);
    expect(v.bcc).toEqual([]);
    expect(v.headers).toEqual({});
    expect(v.from).toBeUndefined();
  });

  it.each([
    'a@b.co',
    'first.last+tag@sub.example.test',
    "o'brien@example.test",
    'x_y@example.test',
  ])('accepts %s', (address) => {
    expect(validateMessage(sampleMessage({ to: address })).to).toEqual([address]);
  });

  it.each([
    ['plain text', 'alice'],
    ['no domain dot', 'alice@localhost'],
    ['a display name', 'Alice <alice@example.test>'],
    ['two addresses', 'a@example.test, b@example.test'],
    ['a semicolon list', 'a@example.test;b@example.test'],
    ['a quote', '"alice"@example.test'],
    ['whitespace', 'al ice@example.test'],
    ['a newline', 'alice@example.test\nBcc: x@example.test'],
    ['an empty string', ''],
    ['over 254 characters', `${'a'.repeat(250)}@example.test`],
  ])('rejects an address with %s', (_label, address) => {
    expect(reasonFor({ to: address })).toMatch(/to\[0\]/);
  });

  it('names the field in the reason and never the value', () => {
    expect(reasonFor({ cc: ['ok@example.test', 'bad address'] })).toContain('cc[1]');
    expect(reasonFor({ subject: 'private subject\r\n' })).not.toContain('private subject');
  });

  it('caps recipients across to, cc and bcc at the Exchange limit', () => {
    const many = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag}${i}@example.test`);
    expect(() =>
      validateMessage(
        sampleMessage({ to: many(300, 'a'), cc: many(100, 'b'), bcc: many(100, 'c') }),
      ),
    ).not.toThrow();
    expect(reasonFor({ to: many(300, 'a'), cc: many(100, 'b'), bcc: many(101, 'c') })).toMatch(
      new RegExp(`more than ${MESSAGE_LIMITS.maxRecipients}`),
    );
  });

  it('requires a non-empty subject, html and text', () => {
    expect(reasonFor({ subject: '' })).toMatch(/subject/);
    expect(reasonFor({ html: '' })).toMatch(/html/);
    expect(reasonFor({ text: '' })).toMatch(/text/);
  });

  it('rejects control characters in the subject, a header value and the idempotency key', () => {
    expect(reasonFor({ subject: 'a\u0000b' })).toMatch(/control character/);
    expect(reasonFor({ headers: { 'x-a': 'b\nc' } })).toMatch(/x-a/);
    expect(reasonFor({ idempotencyKey: 'a\u0007b' })).toMatch(/idempotencyKey/);
  });

  it('allows only x- headers, and only a few', () => {
    expect(reasonFor({ headers: { 'List-Unsubscribe': '<mailto:u@example.test>' } })).toMatch(/x-/);
    const tooMany = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`x-h${i}`, 'v']));
    expect(reasonFor({ headers: tooMany })).toMatch(/too many headers/);
  });

  it('bounds the body size by bytes, not characters', () => {
    const justUnder = 'a'.repeat(MESSAGE_LIMITS.maxBodyBytes);
    expect(() => validateMessage(sampleMessage({ html: justUnder }))).not.toThrow();
    expect(reasonFor({ html: 'é'.repeat(MESSAGE_LIMITS.maxBodyBytes / 2 + 1) })).toMatch(
      /html is too large/,
    );
  });

  it.each(['auth.verify-email', 'digest.daily', 'invoice_paid', 'x'])(
    'accepts category %s',
    (category) => {
      expect(validateMessage(sampleMessage({ category })).category).toBe(category);
    },
  );

  it.each(['', 'Auth', '1abc', 'a..b', 'a b', 'a'.repeat(65), 'a.'])(
    'rejects category %o',
    (category) => {
      expect(reasonFor({ category })).toMatch(/category/);
    },
  );

  it('rejects a non-object', () => {
    expect(() => validateMessage(null as unknown as EmailMessage)).toThrow(MailSendError);
  });

  it('accepts the message identity v8 builds (its narrower EmailMessage)', () => {
    const fromIdentity = {
      to: 'user@example.test',
      subject: 'Reset your password',
      html: '<p>x</p>',
      text: 'x',
      category: 'auth.reset-password',
      idempotencyKey: 'reset-password:0190f3a2-0000-7000-8000-000000000000:' + 'a'.repeat(64),
    } as const;
    expect(validateMessage(fromIdentity).category).toBe('auth.reset-password');
  });

  describe('control characters (L1)', () => {
    it.each([
      ['NUL', 'ali\u0000ce@example.test'],
      ['BEL', 'alice\u0007@example.test'],
      ['ESC', 'alice@exam\u001bple.test'],
      ['DEL', 'alice\u007f@example.test'],
      ['vertical tab', 'ali\u000bce@example.test'],
    ])('rejects an address with %s in every address field, naming the field', (_label, address) => {
      expect(reasonFor({ to: address })).toMatch(/to\[0\] contains a control character/);
      expect(reasonFor({ cc: [address] })).toMatch(/cc\[0\]/);
      expect(reasonFor({ bcc: [address] })).toMatch(/bcc\[0\]/);
      expect(reasonFor({ replyTo: address })).toMatch(/replyTo/);
      expect(reasonFor({ from: address })).toMatch(/from/);
    });
  });

  describe('reserved headers (L5)', () => {
    it.each([
      'X-MS-Exchange-Organization-SCL',
      'x-ms-exchange-organization-authas',
      'X-MS-Exchange-Transport-Rules-Loop',
      'X-Microsoft-Antispam',
      'x-microsoft-antispam-prvs',
    ])('rejects %s: Exchange reads it', (name) => {
      expect(reasonFor({ headers: { [name]: 'x' } })).toMatch(/reserved by Exchange/);
    });

    it('still allows an ordinary x- header, including one that merely contains "ms"', () => {
      expect(
        validateMessage(sampleMessage({ headers: { 'x-ms-note': '1', 'x-qnsc-trace': 'abc' } }))
          .headers,
      ).toEqual({
        'x-ms-note': '1',
        'x-qnsc-trace': 'abc',
      });
    });
  });

  describe('correlationId (contract §7)', () => {
    it.each([12345, 1.5, true, {}, ['a'], null])(
      'rejects the non-string %o instead of coercing it',
      (value) => {
        expect(reasonFor({ correlationId: value as never })).toMatch(/correlationId/);
      },
    );

    it.each([
      'abc',
      'req-01HZX',
      'a.b_c:d-e',
      '0190f3a2-0000-7000-8000-000000000000',
      'mail.send:job-1',
      'a'.repeat(128),
    ])('accepts %s', (id) => {
      expect(validateMessage(sampleMessage({ correlationId: id })).correlationId).toBe(id);
    });

    it('is optional', () => {
      expect(validateMessage(sampleMessage()).correlationId).toBeUndefined();
    });

    it.each([
      ['empty', ''],
      ['129 characters', 'a'.repeat(129)],
      ['a space', 'has space'],
      ['a quote', 'q"uote'],
      ['CR/LF', 'a\r\nb'],
      ['a slash', 'a/b'],
      ['non-ASCII', 'idé'],
    ])('rejects %s, without echoing it', (_label, id) => {
      const reason = reasonFor({ correlationId: id });
      expect(reason).toMatch(/correlationId/);
      expect(reason).not.toContain(id === '' ? '\u0000' : id);
    });
  });
});
