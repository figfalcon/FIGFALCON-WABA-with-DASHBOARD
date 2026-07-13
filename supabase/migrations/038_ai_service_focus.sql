-- 038: per-thread AI service focus + context reset.
--
-- ai_service_focus — which service "sub-agent" currently owns the
--   thread's conversation. NULL = the global agent. Set/cleared by the
--   auto-reply pipeline when the model signals a routing change via
--   sentinel ([[SERVICE:...]]). Persisting it on the conversation is
--   what lets a lead ghost and come back days later to the SAME
--   specialist context instead of restarting discovery.
--
-- ai_context_reset_at — "the AI's memory starts here." When a lead
--   sends the literal keyword `reset`, we stamp this and the context
--   builder only feeds the model messages created after it. The full
--   message history stays intact in the inbox — only the model's view
--   is truncated.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_service_focus text
    CHECK (ai_service_focus IN
      ('voice_ai', 'website_funnel', 'chatbot_leads', 'cold_email', 'ai_content')),
  ADD COLUMN IF NOT EXISTS ai_context_reset_at timestamptz;
