/**
 * Normalize a CSV phone value to clean +CC format for storage:
 * strip spaces/dashes/brackets, resolve trunk zeros, and apply the
 * user-chosen default country code when the number has none.
 *
 *   "+91 9160282718"  → "+919160282718"
 *   "072489 66748"    → "+917248966748"   (cc +91)
 *   "917995602748"    → "+917995602748"   (already has cc digits)
 *   "0091 72489..."   → "+9172489..."     (00 international prefix)
 */
export function normalizeImportPhone(raw: string, countryCode: string): string {
  const ccDigits = countryCode.replace(/\D/g, '');
  let p = raw.trim().replace(/[^\d+]/g, '');
  if (!p) return p;

  if (p.startsWith('+')) {
    return '+' + p.slice(1).replace(/\D/g, '');
  }
  if (p.startsWith('00')) {
    return '+' + p.slice(2).replace(/^0+/, '');
  }

  p = p.replace(/^0+/, '');

  // Already starts with the country code digits AND is longer than a
  // bare 10-digit subscriber number → just prefix "+". The length gate
  // matters: an Indian mobile like 9160282718 begins with "91" but is
  // a bare number, not a prefixed one.
  if (ccDigits && p.startsWith(ccDigits) && p.length > 10) {
    return '+' + p;
  }

  return ccDigits ? `+${ccDigits}${p}` : p;
}
