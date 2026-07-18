'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, Loader2, Plus, Link as LinkIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface LibraryEntry {
  id: string;
  name: string;
  language: string;
  category: string;
  topic?: string;
  usecase?: string;
  body?: string;
  buttons?: { type: string; text?: string; url?: string }[];
}

interface TemplateLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a library template was created so the list refreshes. */
  onCreated: () => void;
}

/**
 * Browse Meta's pre-vetted Template Library (utility templates:
 * feedback surveys, reminders, confirmations) and create one on the
 * WABA in a click. Library creations are usually approved instantly
 * because Meta wrote the copy.
 */
export function TemplateLibraryDialog({
  open,
  onOpenChange,
  onCreated,
}: TemplateLibraryDialogProps) {
  const t = useTranslations('Settings.templates');

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  /** Library entry currently being configured/created. */
  const [addingId, setAddingId] = useState<string | null>(null);
  const [buttonUrl, setButtonUrl] = useState('https://cal.com/figfalcon/figfalcon-strategy-call');
  const [busy, setBusy] = useState(false);

  const fetchLibrary = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const params = query.trim() ? `?search=${encodeURIComponent(query.trim())}` : '';
      const res = await fetch(`/api/whatsapp/templates/library${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Library request failed');
      setResults(json.data ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('libraryLoadFailed'));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) {
      setAddingId(null);
      void fetchLibrary(search);
    }
    // Intentionally not refetching on every keystroke — Enter/button only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleCreate(entry: LibraryEntry) {
    const hasUrlButton = (entry.buttons ?? []).some((b) => b.type === 'URL');
    setBusy(true);
    try {
      const res = await fetch('/api/whatsapp/templates/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: entry.name,
          library_template_name: entry.name,
          language: entry.language || 'en_US',
          ...(hasUrlButton ? { button_url: buttonUrl } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Creation failed');
      toast.success(
        t('libraryCreated', { name: entry.name, status: json.meta_status ?? 'PENDING' }),
      );
      setAddingId(null);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('libraryCreateFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden border-border bg-popover p-0 text-popover-foreground sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border px-6 pb-4 pt-6">
          <DialogTitle className="text-popover-foreground">
            {t('libraryTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('libraryDesc')}
          </DialogDescription>
          <div className="mt-2 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void fetchLibrary(search);
                  }
                }}
                placeholder={t('librarySearchPlaceholder')}
                className="bg-muted pl-9 text-foreground"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => void fetchLibrary(search)}
              disabled={loading}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : t('librarySearchBtn')}
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-primary" />
            </div>
          ) : results.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {t('libraryEmpty')}
            </p>
          ) : (
            <div className="space-y-3">
              {results.map((entry) => {
                const hasUrlButton = (entry.buttons ?? []).some((b) => b.type === 'URL');
                const isConfiguring = addingId === entry.id;
                return (
                  <div
                    key={entry.id}
                    className="rounded-xl border border-border bg-card/50 p-4"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground" title={entry.name}>
                          {entry.name}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
                            {entry.category}
                          </span>
                          {entry.topic && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                              {entry.topic.replaceAll('_', ' ')}
                            </span>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          hasUrlButton && !isConfiguring
                            ? setAddingId(entry.id)
                            : void handleCreate(entry)
                        }
                        className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        {busy && isConfiguring ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Plus className="size-3.5" />
                        )}
                        {t('libraryAddBtn')}
                      </Button>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {entry.body}
                    </p>
                    {(entry.buttons ?? []).length > 0 && (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {t('libraryButtons', {
                          names: (entry.buttons ?? [])
                            .map((b) => b.text ?? b.type)
                            .join(', '),
                        })}
                      </p>
                    )}
                    {isConfiguring && (
                      <div className="mt-3 space-y-1.5 rounded-lg border border-border bg-muted/40 p-3">
                        <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                          <LinkIcon className="size-3.5 text-primary" />
                          {t('libraryUrlLabel')}
                        </label>
                        <Input
                          value={buttonUrl}
                          onChange={(e) => setButtonUrl(e.target.value)}
                          className="h-8 bg-muted text-foreground"
                        />
                        <div className="flex justify-end gap-2 pt-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setAddingId(null)}
                            className="border-border text-muted-foreground hover:bg-muted"
                          >
                            {t('cancel')}
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy || !buttonUrl.trim()}
                            onClick={() => void handleCreate(entry)}
                            className="bg-primary text-primary-foreground hover:bg-primary/90"
                          >
                            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                            {t('libraryConfirmBtn')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
