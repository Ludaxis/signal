// The login page's `next` parameter: only same-origin paths survive.
import { describe, expect, it } from 'vitest';
import { safeNext } from '@/app/login/LoginForm';

const APP = 'http://127.0.0.1:3000';

describe('safeNext', () => {
  it('keeps same-origin paths with their query and hash', () => {
    expect(safeNext('/studio?x', APP)).toBe('/studio?x');
    expect(safeNext('/studio/connections?project=demo#keys', APP)).toBe('/studio/connections?project=demo#keys');
    expect(safeNext('/', APP)).toBe('/');
    expect(safeNext('/studio/../calendar', APP)).toBe('/calendar');
  });

  it('refuses control characters that URL parsers strip (TAB, CR, LF) and backslashes', () => {
    expect(safeNext('/\t/evil.com', APP)).toBe('/studio');
    expect(safeNext('/\r/evil.com', APP)).toBe('/studio');
    expect(safeNext('/\n/evil.com', APP)).toBe('/studio');
    expect(safeNext('/\u0000x', APP)).toBe('/studio');
    expect(safeNext('/\u0085x', APP)).toBe('/studio');
    expect(safeNext('/\\evil.com', APP)).toBe('/studio');
    expect(safeNext('/studio\\..\\x', APP)).toBe('/studio');
  });

  it('refuses protocol-relative and absolute URLs', () => {
    expect(safeNext('//evil.com', APP)).toBe('/studio');
    expect(safeNext('//evil.com/phish', APP)).toBe('/studio');
    expect(safeNext('https://evil.com/', APP)).toBe('/studio');
    expect(safeNext('http://127.0.0.1:3000/studio', APP)).toBe('/studio'); // absolute, even same origin: refused, falls back
    expect(safeNext('javascript:alert(1)', APP)).toBe('/studio');
    expect(safeNext('studio', APP)).toBe('/studio');
  });

  it('falls back to the Studio for empty, oversized or unusable input', () => {
    expect(safeNext(null, APP)).toBe('/studio');
    expect(safeNext('', APP)).toBe('/studio');
    expect(safeNext(`/${'a'.repeat(3000)}`, APP)).toBe('/studio');
    expect(safeNext('/studio', 'null')).toBe('/studio');
  });

  it('uses the page origin by default', () => {
    expect(safeNext('/calendar')).toBe('/calendar');
    expect(safeNext('/\t/evil.com')).toBe('/studio');
  });
});
