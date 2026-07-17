import type { CustomField } from '@/types';

/**
 * Canonical display order for custom field columns: sort_order first
 * (migration 039), name as tiebreak. Sorting happens client-side so
 * the UI keeps working even before the migration adds the column
 * (missing sort_order reads as 0 for every row → pure name order).
 */
export function sortCustomFields(fields: CustomField[]): CustomField[] {
  return [...fields].sort(
    (a, b) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
      a.field_name.localeCompare(b.field_name),
  );
}
