import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseTagCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: true,
      hasCompanyColumn: false,
      customColumns: [],
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
          custom: {},
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
          custom: {},
        },
      ],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      customColumns: [],
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
          custom: {},
        },
      ],
    });
  });

  it('matches header aliases like "Phone Number" and "Company Name"', () => {
    const csv = `Company Name,Full Name,Phone Number,Email Address
Figfalcon,Bikram,917995602748,ai@figfalcon.com`;

    const result = parseContactCsv(csv);
    expect(result.hasCompanyColumn).toBe(true);
    expect(result.customColumns).toEqual([]);
    expect(result.rows).toEqual([
      {
        phone: '917995602748',
        name: 'Bikram',
        email: 'ai@figfalcon.com',
        company: 'Figfalcon',
        tagNames: [],
        custom: {},
      },
    ]);
  });

  it('captures unrecognized columns as custom fields', () => {
    const csv = `Company,name,phone number,Website available,website,Clinic rating.,City
Figgy,,917995602748,,figfalcon.com,,pune`;

    const result = parseContactCsv(csv);
    expect(result.customColumns).toEqual([
      'Website available',
      'website',
      'Clinic rating',
      'City',
    ]);
    expect(result.rows).toEqual([
      {
        phone: '917995602748',
        name: undefined,
        email: undefined,
        company: 'Figgy',
        tagNames: [],
        custom: {
          website: 'figfalcon.com',
          City: 'pune',
        },
      },
    ]);
  });

  it('returns no rows when no phone-like header exists', () => {
    const csv = `name,email
Alice,alice@x.test`;

    expect(parseContactCsv(csv).rows).toEqual([]);
  });

  it('parses a tab-separated spreadsheet paste', () => {
    // What copying cells from Google Sheets / Excel yields.
    const tsv =
      'Company name\tname\tphone number\tCity\n' +
      'Vedant Dental\tDr. Prakash\t72489 66748\tAlandi';

    const result = parseContactCsv(tsv);
    expect(result.hasCompanyColumn).toBe(true);
    expect(result.customColumns).toEqual(['City']);
    expect(result.rows).toEqual([
      {
        phone: '72489 66748',
        name: 'Dr. Prakash',
        email: undefined,
        company: 'Vedant Dental',
        tagNames: [],
        custom: { City: 'Alandi' },
      },
    ]);
  });
});
