"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import {
  Search,
  ChevronDown,
  X,
  CheckSquare,
  Check,
  MailOpen,
  Archive,
  Trash2,
  Loader2,
  Pin,
  PinOff,
  Copy,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}




type InboxFilter = ConversationStatus | "all" | "unread";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  
  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
  ], [t]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    // Pinned rows always float to the top (newest pin first). Beyond
    // that, keep the DB's last_message_at order.
    result = [...result].sort((a, b) => {
      const pa = a.pinned_at ? new Date(a.pinned_at).getTime() : 0;
      const pb = b.pinned_at ? new Date(b.pinned_at).getTime() : 0;
      if (pa !== pb) return pb - pa;
      const la = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const lb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return lb - la;
    });

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  // ── Right-click / long-press context menu on a single row ─────
  // Coordinates are viewport-relative; null means "closed".
  const [rowMenu, setRowMenu] = useState<{
    conv: Conversation;
    x: number;
    y: number;
  } | null>(null);
  const closeRowMenu = useCallback(() => setRowMenu(null), []);

  const updateConvLocal = useCallback(
    (id: string, patch: Partial<Conversation>) => {
      onConversationsLoaded(
        conversations.map((c) => (c.id === id ? { ...c, ...patch } : c))
      );
    },
    [conversations, onConversationsLoaded]
  );

  const togglePin = useCallback(
    async (conv: Conversation) => {
      const supabase = createClient();
      const nextPin = conv.pinned_at ? null : new Date().toISOString();
      updateConvLocal(conv.id, { pinned_at: nextPin });
      const { error } = await supabase
        .from("conversations")
        .update({ pinned_at: nextPin })
        .eq("id", conv.id);
      if (error) {
        toast.error(t("pinFailed"));
        // revert optimistic
        updateConvLocal(conv.id, { pinned_at: conv.pinned_at });
        return;
      }
      toast.success(nextPin ? t("pinned") : t("unpinned"));
    },
    [updateConvLocal, t]
  );

  const markConvRead = useCallback(
    async (conv: Conversation) => {
      if (conv.unread_count === 0) return;
      const supabase = createClient();
      updateConvLocal(conv.id, { unread_count: 0 });
      const { error } = await supabase
        .from("conversations")
        .update({ unread_count: 0 })
        .eq("id", conv.id);
      if (error) toast.error(t("bulkFailed"));
    },
    [updateConvLocal, t]
  );

  const setConvStatus = useCallback(
    async (conv: Conversation, status: ConversationStatus) => {
      const supabase = createClient();
      updateConvLocal(conv.id, { status });
      const { error } = await supabase
        .from("conversations")
        .update({ status })
        .eq("id", conv.id);
      if (error) toast.error(t("bulkFailed"));
    },
    [updateConvLocal, t]
  );

  const copyPhone = useCallback(
    async (conv: Conversation) => {
      const phone = conv.contact?.phone;
      if (!phone) return;
      try {
        await navigator.clipboard.writeText(phone);
        toast.success(t("phoneCopied", { phone }));
      } catch {
        toast.error(t("phoneCopyFailed"));
      }
    },
    [t]
  );

  const deleteConv = useCallback(
    async (conv: Conversation) => {
      if (!window.confirm(t("deleteOneConfirm"))) return;
      const supabase = createClient();
      // Deals hold a non-cascading FK — detach first.
      await supabase
        .from("deals")
        .update({ conversation_id: null })
        .eq("conversation_id", conv.id);
      const { error } = await supabase
        .from("conversations")
        .delete()
        .eq("id", conv.id);
      if (error) {
        toast.error(t("bulkFailed"));
        return;
      }
      onConversationsLoaded(conversations.filter((c) => c.id !== conv.id));
      toast.success(t("deletedOne"));
    },
    [conversations, onConversationsLoaded, t]
  );

  // ── Bulk selection (mark read / close / delete) ────────────────
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const bulkMarkRead = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkBusy(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("conversations")
      .update({ unread_count: 0 })
      .in("id", ids);
    setBulkBusy(false);
    if (error) {
      toast.error(t("bulkFailed"));
      return;
    }
    onConversationsLoaded(
      conversations.map((c) =>
        selectedIds.has(c.id) ? { ...c, unread_count: 0 } : c,
      ),
    );
    toast.success(t("bulkMarkedRead", { count: ids.length }));
    exitSelectMode();
  }, [selectedIds, conversations, onConversationsLoaded, exitSelectMode, t]);

  const bulkClose = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkBusy(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("conversations")
      .update({ status: "closed" })
      .in("id", ids);
    setBulkBusy(false);
    if (error) {
      toast.error(t("bulkFailed"));
      return;
    }
    onConversationsLoaded(
      conversations.map((c) =>
        selectedIds.has(c.id) ? { ...c, status: "closed" as ConversationStatus } : c,
      ),
    );
    toast.success(t("bulkClosed", { count: ids.length }));
    exitSelectMode();
  }, [selectedIds, conversations, onConversationsLoaded, exitSelectMode, t]);

  const bulkDelete = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(t("bulkDeleteConfirm", { count: ids.length }))) return;
    setBulkBusy(true);
    const supabase = createClient();
    // Deals keep a non-cascading FK to conversations — detach them
    // first so the delete can't fail mid-way.
    await supabase
      .from("deals")
      .update({ conversation_id: null })
      .in("conversation_id", ids);
    const { error } = await supabase.from("conversations").delete().in("id", ids);
    setBulkBusy(false);
    if (error) {
      toast.error(t("bulkFailed"));
      return;
    }
    onConversationsLoaded(conversations.filter((c) => !selectedIds.has(c.id)));
    toast.success(t("bulkDeleted", { count: ids.length }));
    exitSelectMode();
  }, [selectedIds, conversations, onConversationsLoaded, exitSelectMode, t]);

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            className={cn(
              "inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs hover:bg-muted",
              selectMode
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            title={t("selectTitle")}
          >
            <CheckSquare className="h-3.5 w-3.5" />
            {selectMode ? t("selectCancel") : t("select")}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Bulk action bar — shown while selecting */}
      {selectMode && (
        <div className="flex items-center justify-between gap-1 border-b border-border bg-muted/40 px-3 py-1.5">
          <span className="text-xs text-foreground">
            {t("selectedCount", { count: selectedIds.size })}
          </span>
          <div className="flex items-center gap-0.5">
            {bulkBusy ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void bulkMarkRead()}
                  disabled={selectedIds.size === 0}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  title={t("bulkMarkRead")}
                >
                  <MailOpen className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void bulkClose()}
                  disabled={selectedIds.size === 0}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  title={t("bulkClose")}
                >
                  <Archive className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void bulkDelete()}
                  disabled={selectedIds.size === 0}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-red-400 disabled:opacity-30"
                  title={t("bulkDelete")}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                selectMode={selectMode}
                selected={selectedIds.has(conv.id)}
                onToggleSelect={toggleSelected}
                onOpenMenu={(c, x, y) => setRowMenu({ conv: c, x, y })}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {rowMenu && (
        <RowContextMenu
          conv={rowMenu.conv}
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={closeRowMenu}
          onTogglePin={() => togglePin(rowMenu.conv)}
          onMarkRead={() => markConvRead(rowMenu.conv)}
          onSetStatus={(s) => setConvStatus(rowMenu.conv, s)}
          onCopyPhone={() => copyPhone(rowMenu.conv)}
          onDelete={() => deleteConv(rowMenu.conv)}
          t={t}
        />
      )}
    </div>
  );
}

function RowContextMenu({
  conv,
  x,
  y,
  onClose,
  onTogglePin,
  onMarkRead,
  onSetStatus,
  onCopyPhone,
  onDelete,
  t,
}: {
  conv: Conversation;
  x: number;
  y: number;
  onClose: () => void;
  onTogglePin: () => void;
  onMarkRead: () => void;
  onSetStatus: (s: ConversationStatus) => void;
  onCopyPhone: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  // Clamp position so a menu at the right edge doesn't overflow.
  const MENU_W = 220;
  const MENU_H = 230;
  const left = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1000) - MENU_W - 8);
  const top = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 800) - MENU_H - 8);

  useEffect(() => {
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Delay to ignore the right-click that opened us.
    const id = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const pinned = Boolean(conv.pinned_at);
  const item =
    "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted";

  return (
    <div
      role="menu"
      style={{ left, top, width: MENU_W }}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 rounded-lg border border-border bg-popover p-1 shadow-lg"
    >
      <button
        type="button"
        onClick={() => {
          onTogglePin();
          onClose();
        }}
        className={item}
      >
        {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
        {pinned ? t("menuUnpin") : t("menuPin")}
      </button>
      <button
        type="button"
        disabled={conv.unread_count === 0}
        onClick={() => {
          onMarkRead();
          onClose();
        }}
        className={cn(item, "disabled:opacity-40")}
      >
        <MailOpen className="h-4 w-4" />
        {t("menuMarkRead")}
      </button>
      {conv.status !== "closed" && (
        <button
          type="button"
          onClick={() => {
            onSetStatus("closed");
            onClose();
          }}
          className={item}
        >
          <Archive className="h-4 w-4" />
          {t("menuArchive")}
        </button>
      )}
      {conv.status === "closed" && (
        <button
          type="button"
          onClick={() => {
            onSetStatus("open");
            onClose();
          }}
          className={item}
        >
          <Archive className="h-4 w-4" />
          {t("menuReopen")}
        </button>
      )}
      <button
        type="button"
        disabled={!conv.contact?.phone}
        onClick={() => {
          onCopyPhone();
          onClose();
        }}
        className={cn(item, "disabled:opacity-40")}
      >
        <Copy className="h-4 w-4" />
        {t("menuCopyPhone")}
      </button>
      <div className="my-1 border-t border-border" />
      <button
        type="button"
        onClick={() => {
          onDelete();
          onClose();
        }}
        className={cn(item, "hover:bg-red-500/10 hover:text-red-400")}
      >
        <Trash2 className="h-4 w-4" />
        {t("menuDelete")}
      </button>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Bulk-selection mode: clicks toggle selection instead of opening. */
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  /** Right-click / long-press → open the per-row action menu. */
  onOpenMenu: (conv: Conversation, x: number, y: number) => void;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  selectMode,
  selected,
  onToggleSelect,
  onOpenMenu,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    if (selectMode) onToggleSelect(conversation.id);
    else onSelect(conversation);
  }, [selectMode, onToggleSelect, onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onOpenMenu(conversation, e.clientX, e.clientY);
    },
    [conversation, onOpenMenu]
  );

  return (
    <button
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && !selectMode && "border-l-2 border-primary bg-muted/70",
        selectMode && selected && "bg-primary/10",
        conversation.pinned_at && "bg-muted/25"
      )}
    >
      {selectMode && (
        <span
          className={cn(
            "mt-2.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/50"
          )}
        >
          {selected && <Check className="h-3 w-3" />}
        </span>
      )}
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1">
            {conversation.pinned_at && (
              <Pin
                className="h-3 w-3 shrink-0 text-primary"
                aria-label={t("pinned")}
              />
            )}
            <span className="truncate text-sm font-medium text-foreground">
              {displayName}
            </span>
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          {/* Unread indicator only — a WhatsApp-style blue dot + count
              that disappear entirely once the thread has been opened.
              (The old always-on status dot read as a false "unread"
              signal on every row; status still lives in the thread
              header and the list's status filter.) */}
          {conversation.unread_count > 0 && (
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
              <span className="h-2 w-2 rounded-full bg-primary" />
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
