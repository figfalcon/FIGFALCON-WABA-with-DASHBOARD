'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import type { CustomField } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Plus, Trash2, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { sortCustomFields } from '@/lib/contacts/sort-custom-fields';

interface CustomFieldsManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog wrapper around {@link CustomFieldsPanel}, used on the Contacts page.
 * The same panel is rendered inline under Settings → Custom Fields, so the
 * editing UI lives in one place. Radix unmounts the dialog content on close,
 * so the panel remounts (and refetches) on each open.
 */
export function CustomFieldsManager({
  open,
  onOpenChange,
}: CustomFieldsManagerProps) {
  const t = useTranslations('Contacts.customFields');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('desc')}
          </DialogDescription>
        </DialogHeader>
        <CustomFieldsPanel />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Create / rename / delete account-wide custom contact field definitions.
 * Per-contact values are edited elsewhere (contact detail → Custom Fields);
 * this only manages the field catalogue. Admin+ gated by the caller — the
 * `custom_fields` RLS also rejects non-admin writes as defense in depth.
 */
export function CustomFieldsPanel() {
  const t = useTranslations('Contacts.customFields');
  const supabase = createClient();
  const { user, accountId } = useAuth();

  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchFields = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data } = await supabase
      .from('custom_fields')
      .select('*')
      .order('field_name');
    setFields(sortCustomFields((data as CustomField[] | null) ?? []));
    setLoading(false);
  }, [supabase, accountId]);

  // Load the field list on mount once the account is known. The setters
  // inside fetchFields run after the Supabase await — not synchronously in
  // the effect body — so the cascade the lint rule warns about doesn't apply.
  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchFields();
    }
  }, [accountId, fetchFields]);

  /** Case-insensitive name clash within the loaded list. */
  function isDuplicate(name: string, exceptId?: string): boolean {
    const lower = name.toLowerCase();
    return fields.some(
      (f) => f.id !== exceptId && f.field_name.toLowerCase() === lower
    );
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    if (!accountId || !user) {
      toast.error(t('toastNoAccount'));
      return;
    }
    if (isDuplicate(name)) {
      toast.error(t('toastDuplicate', { name }));
      return;
    }

    setCreating(true);
    const { error } = await supabase.from('custom_fields').insert({
      field_name: name,
      field_type: 'text',
      user_id: user.id,
      account_id: accountId,
    });
    setCreating(false);

    if (error) {
      toast.error(t('toastCreateFailed'));
      return;
    }
    toast.success(t('toastCreated', { name }));
    setNewName('');
    await fetchFields();
  }

  /** Returns true on success so the row can keep the new name, false so it
   *  reverts to the previous one. No-ops (blank / unchanged) count as success. */
  async function handleRename(
    field: CustomField,
    nextName: string
  ): Promise<boolean> {
    const name = nextName.trim();
    if (!name || name === field.field_name) return true;
    if (isDuplicate(name, field.id)) {
      toast.error(t('toastDuplicate', { name }));
      return false;
    }
    setBusyId(field.id);
    const { error } = await supabase
      .from('custom_fields')
      .update({ field_name: name })
      .eq('id', field.id);
    setBusyId(null);
    if (error) {
      toast.error(t('toastRenameFailed'));
      return false;
    }
    await fetchFields();
    return true;
  }

  // ── Drag-and-drop reordering ──────────────────────────────────
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  /** Persist the given order as dense 0..n-1 sort_order values. */
  async function persistOrder(next: CustomField[]) {
    // Optimistic — the list snaps to the new order immediately.
    setFields(next.map((f, i) => ({ ...f, sort_order: i })));
    for (let i = 0; i < next.length; i++) {
      if ((next[i].sort_order ?? 0) === i) continue;
      const { error } = await supabase
        .from('custom_fields')
        .update({ sort_order: i })
        .eq('id', next[i].id);
      if (error) {
        toast.error(t('toastReorderFailed'));
        await fetchFields(); // roll back to server truth
        return;
      }
    }
  }

  function handleDrop() {
    if (dragIdx !== null && overIdx !== null && dragIdx !== overIdx) {
      const next = [...fields];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(overIdx, 0, moved);
      void persistOrder(next);
    }
    setDragIdx(null);
    setOverIdx(null);
  }

  async function handleDelete(field: CustomField) {
    if (
      !window.confirm(
        t('deleteConfirm', { name: field.field_name })
      )
    ) {
      return;
    }
    setBusyId(field.id);
    const { error } = await supabase
      .from('custom_fields')
      .delete()
      .eq('id', field.id);
    setBusyId(null);
    if (error) {
      toast.error(t('toastDeleteFailed'));
      return;
    }
    toast.success(t('toastDeleted', { name: field.field_name }));
    await fetchFields();
  }

  return (
    <div className="space-y-4">
      {/* Create */}
      <div className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleCreate();
            }
          }}
          placeholder={t('fieldName')}
          className="bg-muted text-foreground"
        />
        <Button
          onClick={handleCreate}
          disabled={creating || !newName.trim()}
          className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
        >
          {creating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          {t('addField')}
        </Button>
      </div>

      {/* List */}
      <div className="max-h-72 overflow-y-auto rounded-md border border-border">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('loading')}
          </div>
        ) : fields.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {fields.map((field, i) => (
              <FieldRow
                key={field.id}
                field={field}
                busy={busyId === field.id}
                onRename={handleRename}
                onDelete={handleDelete}
                dragging={dragIdx === i}
                dropTarget={overIdx === i && dragIdx !== null && dragIdx !== i}
                onDragStart={() => setDragIdx(i)}
                onDragOver={() => setOverIdx(i)}
                onDrop={handleDrop}
                onDragEnd={() => {
                  setDragIdx(null);
                  setOverIdx(null);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A single editable row. Controlled local state lets us commit on blur /
 *  Enter and cleanly revert to the last saved name when a rename fails. */
function FieldRow({
  field,
  busy,
  onRename,
  onDelete,
  dragging,
  dropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  field: CustomField;
  busy: boolean;
  onRename: (field: CustomField, name: string) => Promise<boolean>;
  onDelete: (field: CustomField) => void;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const t = useTranslations('Contacts.customFields');
  const [name, setName] = useState(field.field_name);
  // Rows are only draggable while the grip is held, so selecting text
  // in the rename input never starts a drag.
  const [armed, setArmed] = useState(false);

  async function commit() {
    if (name.trim() === field.field_name) {
      setName(field.field_name); // normalise any whitespace-only edit
      return;
    }
    const ok = await onRename(field, name);
    if (!ok) setName(field.field_name);
  }

  return (
    <li
      draggable={armed}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={() => {
        setArmed(false);
        onDragEnd();
      }}
      className={cn(
        'flex items-center gap-2 px-3 py-2 transition-colors',
        dragging && 'opacity-40',
        dropTarget && 'bg-primary/10 ring-1 ring-inset ring-primary/40'
      )}
    >
      <span
        onMouseDown={() => setArmed(true)}
        onMouseUp={() => setArmed(false)}
        title={t('dragHint')}
        className="shrink-0 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </span>
      <Input
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        aria-label={t('renameAria', { name: field.field_name })}
        className="focus:border-primary h-8 border-transparent bg-transparent text-foreground hover:border-border"
      />
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        onClick={() => onDelete(field)}
        title={t('deleteTitle')}
        className="shrink-0 text-muted-foreground hover:text-red-400"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Trash2 className="size-4" />
        )}
      </Button>
    </li>
  );
}
