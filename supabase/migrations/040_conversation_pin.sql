-- Pin conversations to the top of the inbox list.
-- `pinned_at` is set when the user pins the row, cleared when unpinned.
-- Sort convention (client-side): pinned rows first (newest pin first),
-- then everyone else by last_message_at.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

-- Fast lookup for "all pinned" queries (partial index — pinned is rare).
CREATE INDEX IF NOT EXISTS idx_conversations_pinned_at
  ON conversations (pinned_at)
  WHERE pinned_at IS NOT NULL;
