-- Custom field column ordering (Contacts table + forms).
-- Lower sort_order renders first; ties break by field_name.
ALTER TABLE custom_fields
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
