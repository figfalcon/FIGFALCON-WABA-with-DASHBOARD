import { describe, expect, it } from 'vitest';
import { normalizeImportPhone } from './normalize-import-phone';

describe('normalizeImportPhone', () => {
  it('strips spaces from an already-prefixed number', () => {
    expect(normalizeImportPhone('+91 9160282718', '+91')).toBe('+919160282718');
  });

  it('strips dashes and brackets', () => {
    expect(normalizeImportPhone('+91-79723 (39423)', '+91')).toBe('+917972339423');
  });

  it('replaces a trunk 0 with the default country code', () => {
    expect(normalizeImportPhone('072489 66748', '+91')).toBe('+917248966748');
  });

  it('adds + when country code digits are already present', () => {
    expect(normalizeImportPhone('917995602748', '+91')).toBe('+917995602748');
  });

  it('prefixes a bare 10-digit number with the country code', () => {
    expect(normalizeImportPhone('9160282718', '+91')).toBe('+919160282718');
  });

  it('handles the 00 international prefix', () => {
    expect(normalizeImportPhone('00919420488741', '+91')).toBe('+919420488741');
  });

  it('accepts a country code entered without +', () => {
    expect(normalizeImportPhone('9160282718', '91')).toBe('+919160282718');
  });

  it('returns empty input unchanged', () => {
    expect(normalizeImportPhone('', '+91')).toBe('');
  });
});
