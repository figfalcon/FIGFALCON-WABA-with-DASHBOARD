-- 037: raise the per-conversation AI auto-reply cap ceiling 20 → 100.
--
-- The original CHECK (migration 029) allowed 1..20, which proved too low
-- for real sales conversations — an active thread can easily need 30-50
-- bot turns before a human takes over. The per-account rate limit and
-- the atomic slot claim still bound runaway loops; this only widens the
-- per-thread budget an admin may configure.
ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_auto_reply_max_per_conversation_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_per_conversation_check
  CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 100);
