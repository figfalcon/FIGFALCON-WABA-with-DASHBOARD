/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 *
 * Header matching is alias-based ("phone number", "Mobile", "WhatsApp"
 * all resolve to phone) and every unrecognized column is surfaced as a
 * CUSTOM column so the importer can persist it to custom_fields /
 * contact_custom_values instead of silently dropping it.
 */

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
  /** Values for unrecognized columns, keyed by the display name in
   *  {@link ParseContactCsvResult.customColumns}. Blank cells omitted. */
  custom: Record<string, string>;
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** True when the CSV header includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the CSV header includes a `company` column. */
  hasCompanyColumn: boolean;
  /** Display names of unrecognized columns, in CSV order. These become
   *  custom fields at import time. */
  customColumns: string[];
}

/**
 * Collapse a raw header cell to a comparable key: lowercase, quotes and
 * trailing punctuation stripped, separators (space/underscore/hyphen)
 * squashed. "Phone Number", "phone_number" and "phone-number" all
 * yield "phonenumber".
 */
function headerKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[.:;]+$/, '')
    .replace(/[\s_-]+/g, '');
}

/** Human-facing name for a custom column: original header, tidied. */
function headerDisplayName(raw: string): string {
  return raw
    .trim()
    .replace(/["']/g, '')
    .replace(/[.:;]+$/, '')
    .trim();
}

const HEADER_ALIASES: Record<string, 'phone' | 'name' | 'email' | 'company' | 'tags'> = {
  phone: 'phone',
  phonenumber: 'phone',
  phoneno: 'phone',
  mobile: 'phone',
  mobilenumber: 'phone',
  whatsapp: 'phone',
  whatsappnumber: 'phone',
  contactnumber: 'phone',
  number: 'phone',
  name: 'name',
  fullname: 'name',
  contactname: 'name',
  email: 'email',
  emailaddress: 'email',
  emailid: 'email',
  company: 'company',
  companyname: 'company',
  organization: 'company',
  organisation: 'company',
  business: 'company',
  tags: 'tags',
  tag: 'tags',
  labels: 'tags',
};

export function parseContactCsv(text: string): ParseContactCsvResult {
  const empty: ParseContactCsvResult = {
    rows: [],
    hasTagsColumn: false,
    hasCompanyColumn: false,
    customColumns: [],
  };

  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return empty;

  // Detect the delimiter so a spreadsheet PASTE (tab-separated, what you
  // get copying cells from Google Sheets / Excel) works exactly like an
  // uploaded CSV. Tabs win when present; otherwise comma.
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const rawHeaders = parseCsvLine(lines[0], delimiter);

  const builtinIdx: Partial<Record<'phone' | 'name' | 'email' | 'company' | 'tags', number>> = {};
  const customByIdx = new Map<number, string>();
  const seenCustomKeys = new Set<string>();
  const keys = rawHeaders.map((h) => headerKey(h));
  const usedIdx = new Set<number>();

  // Pass 1 — exact alias match (first win per field).
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!key) continue;
    const builtin = HEADER_ALIASES[key];
    if (builtin && builtinIdx[builtin] === undefined) {
      builtinIdx[builtin] = i;
      usedIdx.add(i);
    }
  }

  // Pass 2 — fuzzy match for any still-missing built-in, so PREFIXED
  // headers ("Clinic phone number", "Clinic name", "Business email")
  // resolve instead of being dropped. Org-type words route a "...name"
  // header to company (the clinic/business name) rather than the
  // contact's personal name.
  const ORG = /(clinic|hospital|shop|store|firm|company|business|practice|salon|studio|org)/;
  const findFuzzy = (pred: (k: string) => boolean): number => {
    for (let i = 0; i < keys.length; i++) {
      if (usedIdx.has(i) || !keys[i]) continue;
      if (pred(keys[i])) return i;
    }
    return -1;
  };
  const claim = (field: keyof typeof builtinIdx, idx: number) => {
    if (idx >= 0 && builtinIdx[field] === undefined) {
      builtinIdx[field] = idx;
      usedIdx.add(idx);
    }
  };
  if (builtinIdx.phone === undefined)
    claim('phone', findFuzzy((k) => /(phone|mobile|whatsapp)/.test(k)));
  if (builtinIdx.email === undefined)
    claim('email', findFuzzy((k) => k.includes('email')));
  if (builtinIdx.company === undefined)
    claim(
      'company',
      findFuzzy(
        (k) => /(company|business|organi[sz]ation)/.test(k) || (k.includes('name') && ORG.test(k)),
      ),
    );
  if (builtinIdx.name === undefined)
    claim('name', findFuzzy((k) => k.includes('name') && !ORG.test(k)));

  // Pass 3 — everything left becomes a custom column (de-duped by key).
  for (let i = 0; i < rawHeaders.length; i++) {
    if (usedIdx.has(i)) continue;
    const key = keys[i];
    if (!key || seenCustomKeys.has(key)) continue;
    seenCustomKeys.add(key);
    customByIdx.set(i, headerDisplayName(rawHeaders[i]));
  }

  const phoneIdx = builtinIdx.phone;
  if (phoneIdx === undefined) return empty;

  const nameIdx = builtinIdx.name;
  const emailIdx = builtinIdx.email;
  const companyIdx = builtinIdx.company;
  const tagsIdx = builtinIdx.tags;

  const cell = (values: string[], idx: number | undefined): string | undefined => {
    if (idx === undefined) return undefined;
    return values[idx]?.replace(/["']/g, '').trim() || undefined;
  };

  const rows: ParsedContactRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCsvLine(line, delimiter);
    const phone = cell(values, phoneIdx);
    if (!phone) continue;

    const custom: Record<string, string> = {};
    for (const [idx, displayName] of customByIdx) {
      const value = cell(values, idx);
      if (value) custom[displayName] = value;
    }

    rows.push({
      phone,
      name: cell(values, nameIdx),
      email: cell(values, emailIdx),
      company: cell(values, companyIdx),
      tagNames: tagsIdx !== undefined ? parseTagCell(values[tagsIdx]?.replace(/["']/g, '')) : [],
      custom,
    });
  }

  return {
    rows,
    hasTagsColumn: tagsIdx !== undefined,
    hasCompanyColumn: companyIdx !== undefined,
    customColumns: [...customByIdx.values()],
  };
}

/** Simple delimited-line parse (handles quoted fields). Delimiter is
 *  comma for CSV or tab for a spreadsheet paste. */
function parseCsvLine(line: string, delimiter: string = ','): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
