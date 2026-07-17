'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type { Contact, CustomField, Tag, ContactTag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Filter,
  X,
  Send,
} from 'lucide-react';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import { sortCustomFields } from '@/lib/contacts/sort-custom-fields';
import { resolveTemplateForTags } from '@/lib/contacts/tag-template-map';
import { useCan } from '@/hooks/use-can';
import { useAuth } from '@/hooks/use-auth';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';

const PAGE_SIZE = 25;

interface ContactWithTags extends Contact {
  tags?: Tag[];
  /** custom_field_id → value, for the custom field columns. */
  customValues?: Record<string, string>;
}

export default function ContactsPage() {
  const t = useTranslations('Contacts.page');
  const supabase = createClient();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');
  const { accountId } = useAuth();

  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  // Tag filter — contacts shown must have ANY of these tags (OR).
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection (page-scoped — only the loaded rows are selectable)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // All tags for display
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});

  // Custom field definitions — each becomes a table column.
  const [customFields, setCustomFields] = useState<CustomField[]>([]);

  // ── Draggable column order (built-ins + custom fields) ─────────
  // Saved per account in localStorage; unknown/new columns append in
  // their natural position, deleted ones drop out automatically.
  const [colOrder, setColOrder] = useState<string[] | null>(null);
  const [dragColId, setDragColId] = useState<string | null>(null);
  const [overColId, setOverColId] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    try {
      const raw = localStorage.getItem(`contacts-cols:${accountId}`);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setColOrder(JSON.parse(raw) as string[]);
    } catch {
      // corrupted saved order — fall back to the default
    }
  }, [accountId]);

  interface ColDef {
    id: string;
    kind: 'name' | 'phone' | 'email' | 'company' | 'tags' | 'created' | 'custom';
    label: string;
    className?: string;
    field?: CustomField;
  }

  const columns: ColDef[] = useMemo(() => {
    const defs: ColDef[] = [
      { id: 'name', kind: 'name', label: t('tableColumns.name') },
      { id: 'phone', kind: 'phone', label: t('tableColumns.phone') },
      { id: 'email', kind: 'email', label: t('tableColumns.email'), className: 'hidden md:table-cell' },
      { id: 'company', kind: 'company', label: t('tableColumns.company'), className: 'hidden lg:table-cell' },
      ...customFields.map((f): ColDef => ({
        id: f.id,
        kind: 'custom',
        label: f.field_name,
        className: 'hidden lg:table-cell',
        field: f,
      })),
      { id: 'tags', kind: 'tags', label: t('tableColumns.tags'), className: 'hidden md:table-cell' },
      { id: 'created', kind: 'created', label: t('tableColumns.createdAt'), className: 'hidden lg:table-cell' },
    ];
    if (!colOrder) return defs;
    const byId = new Map(defs.map((d) => [d.id, d]));
    const ordered: ColDef[] = [];
    for (const id of colOrder) {
      const d = byId.get(id);
      if (d) {
        ordered.push(d);
        byId.delete(id);
      }
    }
    for (const d of defs) {
      if (byId.has(d.id)) ordered.push(d);
    }
    return ordered;
  }, [customFields, colOrder, t]);

  // ── One-click tag-routed template send ─────────────────────────
  // Approved templates by name (language + body for variable filling).
  const [templatesByName, setTemplatesByName] = useState<
    Map<string, { language: string; body_text: string }>
  >(new Map());
  const [quickSendTarget, setQuickSendTarget] = useState<{
    contact: ContactWithTags;
    templateName: string;
  } | null>(null);
  const [quickSending, setQuickSending] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from('message_templates')
        .select('name, language, body_text')
        .eq('status', 'APPROVED');
      if (!alive) return;
      const map = new Map<string, { language: string; body_text: string }>();
      for (const row of data ?? []) {
        map.set(row.name, {
          language: row.language ?? 'en_US',
          body_text: row.body_text ?? '',
        });
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTemplatesByName(map);
    })();
    return () => {
      alive = false;
    };
  }, [supabase]);

  /** The template the row button would send, or null (no tag route /
   *  template not approved locally). */
  function quickSendTemplateFor(contact: ContactWithTags): string | null {
    const name = resolveTemplateForTags((contact.tags ?? []).map((tg) => tg.name));
    return name && templatesByName.has(name) ? name : null;
  }

  async function handleQuickSend() {
    if (!quickSendTarget) return;
    const { contact, templateName } = quickSendTarget;
    const tpl = templatesByName.get(templateName);
    if (!tpl) return;

    // Fill {{1}} with the lead's name (falling back to company, then a
    // neutral salutation); any further variables get empty strings.
    const varCount = new Set(
      [...tpl.body_text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]),
    ).size;
    const params =
      varCount > 0
        ? [
            contact.name || contact.company || 'Doctor',
            ...Array(Math.max(varCount - 1, 0)).fill(''),
          ]
        : [];

    setQuickSending(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contact.id,
          message_type: 'template',
          template_name: templateName,
          template_language: tpl.language,
          template_params: params,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          t('toastQuickSendFailed', {
            error: (payload as { error?: string }).error ?? `HTTP ${res.status}`,
          }),
        );
        return;
      }
      toast.success(
        t('toastQuickSendOk', {
          template: templateName,
          name: contact.name || contact.phone,
        }),
      );
      setQuickSendTarget(null);
    } finally {
      setQuickSending(false);
    }
  }

  function handleColumnDrop() {
    if (dragColId && overColId && dragColId !== overColId) {
      const ids = columns.map((c) => c.id);
      const from = ids.indexOf(dragColId);
      const to = ids.indexOf(overColId);
      if (from >= 0 && to >= 0) {
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        setColOrder(ids);
        if (accountId) {
          localStorage.setItem(`contacts-cols:${accountId}`, JSON.stringify(ids));
        }
      }
    }
    setDragColId(null);
    setOverColId(null);
  }

  // Guards against out-of-order fetch responses: each fetchContacts run
  // claims a sequence number and only the latest is allowed to commit its
  // results. Without this, rapidly toggling tag filters could let a slower
  // earlier request resolve last and render stale rows.
  const fetchSeq = useRef(0);

  const fetchCustomFieldDefs = useCallback(async () => {
    const { data } = await supabase
      .from('custom_fields')
      .select('*')
      .order('field_name');
    setCustomFields(sortCustomFields((data as CustomField[] | null) ?? []));
  }, [supabase]);

  const fetchTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('*');
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((t) => (map[t.id] = t));
      setTagsMap(map);
      // Drop any filter selections whose tag no longer exists (e.g. a tag
      // deleted elsewhere) so it can't linger invisibly in the query.
      setSelectedTagIds((prev) => {
        const pruned = prev.filter((id) => map[id]);
        return pruned.length === prev.length ? prev : pruned;
      });
    }
  }, [supabase]);

  const fetchContacts = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    // The visible rows are about to change — drop any selection that
    // referred to the old page/search results so the bulk bar can't
    // act on rows the user can no longer see.
    setSelected(new Set());

    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const term = search.trim();

    let contactRows: Contact[];
    let count: number;

    if (selectedTagIds.length > 0) {
      // Tag filter active — resolve it server-side (join + distinct +
      // windowed total count + pagination) so a tag covering many
      // contacts can't silently truncate the result or overflow an IN
      // clause. See migration 025_filter_contacts_by_tags.
      const { data, error } = await supabase.rpc('filter_contacts_by_tags', {
        p_tag_ids: selectedTagIds,
        p_search: term || null,
        p_limit: PAGE_SIZE,
        p_offset: from,
      });
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as { contact: Contact; total_count: number }[];
      contactRows = rows.map((r) => r.contact);
      count = rows.length > 0 ? Number(rows[0].total_count) : 0;
    } else {
      let query = supabase
        .from('contacts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (term) {
        const like = `%${term}%`;
        query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
      }

      const { data, count: exactCount, error } = await query;
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      contactRows = data ?? [];
      count = exactCount ?? 0;
    }

    setTotalCount(count);

    if (contactRows.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // Fetch tags + custom field values for these contacts (one query
    // each for the whole page — no per-row round-trips).
    const contactIds = contactRows.map((c) => c.id);
    const [{ data: contactTags }, { data: customValueRows }] = await Promise.all([
      supabase
        .from('contact_tags')
        .select('contact_id, tag_id')
        .in('contact_id', contactIds),
      supabase
        .from('contact_custom_values')
        .select('contact_id, custom_field_id, value')
        .in('contact_id', contactIds),
    ]);
    if (seq !== fetchSeq.current) return; // superseded by a newer fetch

    const tagsByContact: Record<string, string[]> = {};
    contactTags?.forEach((ct) => {
      if (!tagsByContact[ct.contact_id]) tagsByContact[ct.contact_id] = [];
      tagsByContact[ct.contact_id].push(ct.tag_id);
    });

    const customByContact: Record<string, Record<string, string>> = {};
    customValueRows?.forEach((cv) => {
      if (!customByContact[cv.contact_id]) customByContact[cv.contact_id] = {};
      customByContact[cv.contact_id][cv.custom_field_id] = cv.value ?? '';
    });

    const enriched: ContactWithTags[] = contactRows.map((c) => ({
      ...c,
      tags: (tagsByContact[c.id] ?? [])
        .map((tid) => tagsMap[tid])
        .filter(Boolean),
      customValues: customByContact[c.id] ?? {},
    }));

    setContacts(enriched);
    setLoading(false);
  }, [supabase, page, search, selectedTagIds, tagsMap, t]);

  // Load-once-on-mount-ish data fetches. Each setter inside runs
  // inside an async promise completion (Supabase await), not
  // synchronously in the effect body, so the cascade the lint rule
  // warns about doesn't apply here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTags();
    fetchCustomFieldDefs();
  }, [fetchTags, fetchCustomFieldDefs]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    const { data } = await supabase
      .from('contact_tags')
      .select('*')
      .eq('contact_id', contact.id);
    setEditContact(contact);
    setEditContactTags(data ?? []);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', deleteTarget.id);

    if (error) {
      toast.error(t('toastFailedDelete'));
    } else {
      toast.success(t('toastDeleted'));
      fetchContacts();
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const allOnPageSelected =
    contacts.length > 0 && contacts.every((c) => selected.has(c.id));
  const someOnPageSelected = contacts.some((c) => selected.has(c.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleting(true);

    const { error } = await supabase.from('contacts').delete().in('id', ids);

    if (error) {
      toast.error(t('toastBulkFailedDelete'));
    } else {
      toast.success(t('toastBulkDeleted', { count: ids.length }));
      setSelected(new Set());
      fetchContacts();
    }

    setDeleting(false);
    setBulkDeleteOpen(false);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  // Tag filter helpers. Every change resets to page 0 — the result set
  // shrinks/grows so page N may no longer be valid (mirrors the search box).
  const allTags = Object.values(tagsMap).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const hasActiveFilters = search.trim().length > 0 || selectedTagIds.length > 0;

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
    setPage(0);
  }

  function clearTagFilters() {
    setSelectedTagIds([]);
    setPage(0);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {totalCount > 0 ? t('subtitle', { count: totalCount }) : t('subtitleZero')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEditSettings && (
            <Button
              variant="outline"
              onClick={() => setCustomFieldsOpen(true)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <SlidersHorizontal className="size-4" />
              {t('customFieldsBtn')}
            </Button>
          )}
          <GatedButton
            variant="outline"
            canAct={canEdit}
            gateReason="add or import contacts"
            onClick={() => setImportOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <Upload className="size-4" />
            {t('importBtn')}
          </GatedButton>
          <GatedButton
            canAct={canEdit}
            gateReason="add or import contacts"
            onClick={openAddForm}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" />
            {t('addContactBtn')}
          </GatedButton>
        </div>
      </div>

      {/* Search + tag filter */}
      <div className="space-y-2">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                // Reset pagination when the query changes — the result
                // set shrinks/grows, page N may no longer be valid.
                setPage(0);
              }}
              placeholder={t('searchPlaceholder')}
              className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          {canEditSettings && (
            <Button
              variant="outline"
              onClick={() => setCustomFieldsOpen(true)}
              className="border-border text-muted-foreground hover:bg-muted shrink-0"
              title={t('editColumnsTitle')}
            >
              <SlidersHorizontal className="size-4" />
              {t('editColumnsBtn')}
            </Button>
          )}
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground hover:bg-muted shrink-0"
                />
              }
            >
              <Filter className="size-4" />
              {t('filterByTags')}
              {selectedTagIds.length > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {selectedTagIds.length}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <span className="text-sm font-medium text-popover-foreground">
                  {t('filterByTags')}
                </span>
                {selectedTagIds.length > 0 && (
                  <button
                    onClick={clearTagFilters}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t('clearAll')}
                  </button>
                )}
              </div>
              {allTags.length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {t('noTagsYet')}
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto py-1">
                  {allTags.map((tag) => (
                    <label
                      key={tag.id}
                      className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={selectedTagIds.includes(tag.id)}
                        onCheckedChange={() => toggleTagFilter(tag.id)}
                        aria-label={`Filter by ${tag.name}`}
                      />
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="text-sm text-popover-foreground truncate">
                        {tag.name}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Active tag-filter chips */}
        {selectedTagIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedTagIds.map((id) => {
              const tag = tagsMap[id];
              if (!tag) return null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    backgroundColor: tag.color + '20',
                    color: tag.color,
                  }}
                >
                  {tag.name}
                  <button
                    onClick={() => toggleTagFilter(id)}
                    aria-label={`Remove ${tag.name} filter`}
                    className="hover:opacity-70"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <button
              onClick={clearTagFilters}
              className="text-xs text-muted-foreground hover:text-foreground px-1"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-4 py-2">
          <p className="text-sm text-foreground">
            {t('selectedCount', { count: selected.size })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('clearSelection')}
            </Button>
            <GatedButton
              variant="destructive"
              size="sm"
              canAct={canEdit}
              gateReason="delete contacts"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="size-4" />
              {t('deleteSelected')}
            </GatedButton>
          </div>
        </div>
      )}

      {/* Table — horizontal scroll so custom field columns never squash */}
      <div className="rounded-lg border border-border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={!allOnPageSelected && someOnPageSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={contacts.length === 0}
                  aria-label="Select all contacts on this page"
                />
              </TableHead>
              {columns.map((col) => (
                <TableHead
                  key={col.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDragColId(col.id);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setOverColId(col.id);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleColumnDrop();
                  }}
                  onDragEnd={() => {
                    setDragColId(null);
                    setOverColId(null);
                  }}
                  title={t('dragColumnHint', { name: col.label })}
                  className={`text-muted-foreground cursor-grab whitespace-nowrap select-none active:cursor-grabbing ${
                    col.className ?? ''
                  } ${dragColId === col.id ? 'opacity-40' : ''} ${
                    overColId === col.id && dragColId && dragColId !== col.id
                      ? 'bg-primary/10'
                      : ''
                  }`}
                >
                  {col.label}
                </TableHead>
              ))}
              <TableHead className="text-muted-foreground whitespace-nowrap">
                {t('sendTemplateCol')}
              </TableHead>
              <TableHead className="text-muted-foreground w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={3 + columns.length} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={3 + columns.length} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters
                        ? t('noContactsMatch')
                        : t('noContactsYet')}
                    </p>
                    {!hasActiveFilters && (
                      <GatedButton
                        canAct={canEdit}
                        gateReason="add or import contacts"
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className="mt-2 border-border text-muted-foreground hover:bg-muted"
                      >
                        <Plus className="size-3.5" />
                        {t('addFirstContact')}
                      </GatedButton>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow
                  key={contact.id}
                  className="border-border hover:bg-muted/50 cursor-pointer"
                  onClick={() => openDetail(contact.id)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(contact.id)}
                      onCheckedChange={() => toggleSelect(contact.id)}
                      aria-label={`Select ${contact.name || contact.phone}`}
                    />
                  </TableCell>
                  {columns.map((col) => {
                    switch (col.kind) {
                      case 'name':
                        return (
                          <TableCell key={col.id} className="text-foreground font-medium">
                            {contact.name || <span className="text-muted-foreground italic">{t('unnamed')}</span>}
                          </TableCell>
                        );
                      case 'phone':
                        return (
                          <TableCell key={col.id} className="text-muted-foreground font-mono text-xs">
                            {contact.phone}
                          </TableCell>
                        );
                      case 'email':
                        return (
                          <TableCell key={col.id} className={`text-muted-foreground text-sm ${col.className ?? ''}`}>
                            {contact.email || <span className="text-muted-foreground">-</span>}
                          </TableCell>
                        );
                      case 'company':
                        return (
                          <TableCell key={col.id} className={`text-muted-foreground text-sm ${col.className ?? ''}`}>
                            {contact.company || <span className="text-muted-foreground">-</span>}
                          </TableCell>
                        );
                      case 'custom':
                        return (
                          <TableCell
                            key={col.id}
                            className={`text-muted-foreground max-w-[10rem] truncate text-sm ${col.className ?? ''}`}
                            title={contact.customValues?.[col.id] || undefined}
                          >
                            {contact.customValues?.[col.id] || (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                        );
                      case 'tags':
                        return (
                          <TableCell key={col.id} className={col.className}>
                            <div className="flex flex-wrap gap-1">
                              {contact.tags && contact.tags.length > 0 ? (
                                contact.tags.slice(0, 3).map((tag) => (
                                  <span
                                    key={tag.id}
                                    className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                                    style={{
                                      backgroundColor: tag.color + '20',
                                      color: tag.color,
                                    }}
                                  >
                                    {tag.name}
                                  </span>
                                ))
                              ) : (
                                <span className="text-muted-foreground text-xs">-</span>
                              )}
                              {contact.tags && contact.tags.length > 3 && (
                                <span className="text-[10px] text-muted-foreground">
                                  +{contact.tags.length - 3}
                                </span>
                              )}
                            </div>
                          </TableCell>
                        );
                      case 'created':
                        return (
                          <TableCell key={col.id} className={`text-muted-foreground text-xs ${col.className ?? ''}`}>
                            {new Date(contact.created_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </TableCell>
                        );
                    }
                  })}
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {(() => {
                      const tplName = quickSendTemplateFor(contact);
                      return (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!canEdit || !tplName}
                          onClick={() =>
                            tplName &&
                            setQuickSendTarget({ contact, templateName: tplName })
                          }
                          title={
                            tplName
                              ? t('quickSendTitle', { template: tplName })
                              : t('quickSendNoRoute')
                          }
                          className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                        >
                          <Send className="size-3.5" />
                          {t('quickSendBtn')}
                        </Button>
                      );
                    })()}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={(e) => e.stopPropagation()}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="bg-popover border-border"
                      >
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditForm(contact);
                          }}
                          className="text-popover-foreground focus:bg-muted focus:text-foreground"
                        >
                          <Pencil className="size-4" />
                          {t('editAction')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmDelete(contact);
                          }}
                        >
                          <Trash2 className="size-4" />
                          {t('deleteAction')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t('showingPagination', {
              start: page * PAGE_SIZE + 1,
              end: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount
            })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs text-muted-foreground px-2">
              {t('pageCount', { page: page + 1, total: totalPages })}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          fetchContacts();
          fetchTags();
        }}
        onViewExisting={(id) => {
          setFormOpen(false);
          openDetail(id);
        }}
      />

      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />

      {/* Import Modal — an import can create new custom fields, so
          refresh the column definitions along with the rows */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          fetchContacts();
          fetchCustomFieldDefs();
        }}
      />

      {/* Custom Fields Manager (admin+) */}
      {canEditSettings && (
        <CustomFieldsManager
          open={customFieldsOpen}
          onOpenChange={(open) => {
            setCustomFieldsOpen(open);
            if (!open) {
              fetchCustomFieldDefs();
              fetchContacts();
            }
          }}
        />
      )}

      {/* Tag-routed quick send confirmation */}
      <Dialog
        open={quickSendTarget !== null}
        onOpenChange={(open) => {
          if (!open) setQuickSendTarget(null);
        }}
      >
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('quickSendConfirmTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {quickSendTarget &&
                t('quickSendConfirmDesc', {
                  template: quickSendTarget.templateName,
                  name:
                    quickSendTarget.contact.name ||
                    quickSendTarget.contact.company ||
                    quickSendTarget.contact.phone,
                  phone: quickSendTarget.contact.phone,
                })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setQuickSendTarget(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleQuickSend}
              disabled={quickSending}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {quickSending && <Loader2 className="size-4 animate-spin" />}
              <Send className="size-4" />
              {t('quickSendConfirmBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('deleteContactTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteContactDesc', { name: deleteTarget?.name || deleteTarget?.phone || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteBulkTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteBulkDesc', { count: selected.size })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
