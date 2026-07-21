import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`.
 *
 * Includes `template` messages because a template we sent carries its
 * rendered body (the outreach copy) — without it the model can't tell
 * that WE initiated the conversation and restarts as if the lead
 * contacted us cold. Media / interactive rows are still excluded (no
 * useful text).
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
  /**
   * When set, only messages created strictly AFTER this ISO timestamp
   * are fed to the model — the "reset" keyword stamps this on the
   * conversation so the AI starts fresh while the inbox keeps the full
   * history.
   */
  sinceIso?: string | null,
): Promise<ChatMessage[]> {
  let q = db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'template'])
  if (sinceIso) q = q.gt('created_at', sinceIso)
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}
