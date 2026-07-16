import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Persist CSV custom columns after a contact import.
 *
 * 1. Resolve each column display name to a custom_fields row
 *    (case-insensitive match on field_name), creating missing
 *    definitions when `canCreateFields` allows it.
 * 2. Insert contact_custom_values rows for every imported contact that
 *    carried a value in that column.
 *
 * Returns how many values were written plus the column names that
 * could not be resolved (no definition and not allowed to create one).
 */
export interface ContactCustomAssignment {
  contactId: string;
  /** columnDisplayName → cell value (blank cells already omitted). */
  custom: Record<string, string>;
}

export async function assignImportedCustomFields(
  supabase: SupabaseClient,
  args: {
    accountId: string;
    userId: string;
    customColumns: string[];
    assignments: ContactCustomAssignment[];
    canCreateFields: boolean;
  },
): Promise<{ valuesAssigned: number; skippedColumns: string[] }> {
  const { accountId, userId, customColumns, assignments, canCreateFields } = args;
  if (customColumns.length === 0 || assignments.length === 0) {
    return { valuesAssigned: 0, skippedColumns: [] };
  }

  // Only bother resolving columns that actually carry data.
  const usedColumns = customColumns.filter((col) =>
    assignments.some((a) => a.custom[col]),
  );
  if (usedColumns.length === 0) {
    return { valuesAssigned: 0, skippedColumns: [] };
  }

  const { data: existingFields, error: fieldsErr } = await supabase
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId);
  if (fieldsErr) {
    throw new Error(`Failed to load custom fields: ${fieldsErr.message}`);
  }

  const fieldIdByKey = new Map<string, string>();
  for (const f of existingFields ?? []) {
    fieldIdByKey.set(f.field_name.trim().toLowerCase(), f.id);
  }

  const skippedColumns: string[] = [];
  for (const col of usedColumns) {
    const key = col.trim().toLowerCase();
    if (fieldIdByKey.has(key)) continue;

    if (!canCreateFields) {
      skippedColumns.push(col);
      continue;
    }

    const { data: created, error: createErr } = await supabase
      .from('custom_fields')
      .insert({
        field_name: col,
        field_type: 'text',
        user_id: userId,
        account_id: accountId,
      })
      .select('id')
      .single();

    if (createErr || !created) {
      skippedColumns.push(col);
      continue;
    }
    fieldIdByKey.set(key, created.id);
  }

  const rows: { contact_id: string; custom_field_id: string; value: string }[] = [];
  for (const a of assignments) {
    for (const [col, value] of Object.entries(a.custom)) {
      const fieldId = fieldIdByKey.get(col.trim().toLowerCase());
      if (!fieldId) continue;
      rows.push({ contact_id: a.contactId, custom_field_id: fieldId, value });
    }
  }

  let valuesAssigned = 0;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    // Upsert on (contact_id, custom_field_id) — re-importing a CSV for
    // existing contacts refreshes values instead of erroring.
    const { error } = await supabase
      .from('contact_custom_values')
      .upsert(chunk, { onConflict: 'contact_id,custom_field_id' });
    if (error) {
      throw new Error(`Failed to save custom field values: ${error.message}`);
    }
    valuesAssigned += chunk.length;
  }

  return { valuesAssigned, skippedColumns };
}
