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

  const rawHeaders = parseCsvLine(lines[0]);

  // First alias win per built-in field; later duplicates fall through
  // to custom so "Website available" + "website" both survive as
  // distinct custom columns.
  const builtinIdx: Partial<Record<'phone' | 'name' | 'email' | 'company' | 'tags', number>> = {};
  const customByIdx = new Map<number, string>();
  const seenCustomKeys = new Set<string>();

  for (let i = 0; i < rawHeaders.length; i++) {
    const key = headerKey(rawHeaders[i]);
    if (!key) continue;

    const builtin = HEADER_ALIASES[key];
    if (builtin && builtinIdx[builtin] === undefined) {
      builtinIdx[builtin] = i;
      continue;
    }

    // Unrecognized (or a duplicate alias) → custom column. De-dupe
    // display names case-insensitively; first occurrence wins.
    if (seenCustomKeys.has(key)) continue;
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

    const values = parseCsvLine(line);
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

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
