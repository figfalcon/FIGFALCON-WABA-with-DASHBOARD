import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import {
  runAutomationsForTrigger,
  cancelPendingAutomationRuns,
} from '@/lib/automations/engine'

const INTERESTED_TAG_NAME = 'Interested Lead'

/**
 * Get-or-create the account's "Interested Lead" tag. Looked up by name
 * so repeated calls (one per interested reply, across every conversation)
 * converge on the same row instead of creating duplicates.
 */
async function getOrCreateInterestedTag(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  userId: string,
): Promise<string | null> {
  const { data: existing } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', INTERESTED_TAG_NAME)
    .maybeSingle()
  if (existing?.id) return existing.id as string

  const { data: created, error } = await db
    .from('tags')
    .insert({ account_id: accountId, user_id: userId, name: INTERESTED_TAG_NAME, color: '#22c55e' })
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[ai auto-reply] failed to create interested tag:', error)
    return null
  }
  return (created?.id as string) ?? null
}

/**
 * Reconcile the interest-gated follow-up state after the AI has replied
 * to an inbound message. Runs on EVERY AI reply (not just the turn the
 * model first flags interest), so the follow-up clock re-arms from the
 * lead's latest message. Best-effort; never throws.
 *
 * Behaviour:
 *  - Model flagged "not interested" this turn → drop the Interested tag
 *    and cancel any pending follow-up. No re-arm. Done.
 *  - Model flagged "interested" this turn → ensure the Interested tag.
 *  - Then, if the contact is (now or already) tagged Interested → cancel
 *    the current pending timer (they just replied, so they're active) and
 *    fire a FRESH 12h→24h→48h cascade from now. This is what makes the
 *    sequence restart if an interested lead replies and then goes quiet
 *    again: every reply resets the clock; a later silence re-triggers the
 *    follow-ups from 12h.
 *
 * The webhook already cancels pending runs on every inbound, so a lead a
 * human has taken over (AI off → this never runs) still won't get nagged.
 */
export async function reconcileFollowup(args: {
  db: ReturnType<typeof supabaseAdmin>
  accountId: string
  userId: string
  contactId: string
  /** The model's interest read for this turn, if any. */
  interest?: 'yes' | 'no'
}): Promise<void> {
  const { db, accountId, userId, contactId, interest } = args
  try {
    const tagId = await getOrCreateInterestedTag(db, accountId, userId)
    if (!tagId) return

    if (interest === 'no') {
      await db.from('contact_tags').delete().eq('contact_id', contactId).eq('tag_id', tagId)
      await cancelPendingAutomationRuns(accountId, contactId)
      return
    }

    if (interest === 'yes') {
      await db
        .from('contact_tags')
        .upsert(
          { contact_id: contactId, tag_id: tagId },
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
        )
    }

    // Is the contact currently an interested lead? (True right after a
    // 'yes' upsert above, or from a tag set on an earlier turn.)
    const { count } = await db
      .from('contact_tags')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', contactId)
      .eq('tag_id', tagId)
    if ((count ?? 0) === 0) return // not an interested lead → nothing to arm

    // Reset the clock: clear the current timer (they just replied) and
    // start a fresh cascade so a later silence re-triggers the follow-ups.
    await cancelPendingAutomationRuns(accountId, contactId)
    await runAutomationsForTrigger({
      accountId,
      triggerType: 'tag_added',
      contactId,
      context: { tag_id: tagId },
    })
  } catch (err) {
    console.error('[ai auto-reply] reconcileFollowup failed:', err)
  }
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // The AI Agent is the always-on responder: it must reply to every
    // inbound message (first message, mid-conversation, cold contact —
    // anything) until a human explicitly takes over. Eligibility is
    // therefore gated ONLY by human ownership, an explicit per-thread
    // pause, and the reply cap — checked below.
    //
    // We deliberately do NOT stand down just because the account has an
    // active message-level automation. That old behaviour silently muted
    // the AI account-wide the moment any `new_message_received` /
    // `keyword_match` automation existed (e.g. a background tag/wait
    // follow-up), which broke the "AI always replies" guarantee. Interest
    // tracking for follow-ups is now driven off the AI's own judgement
    // (see applyInterestSignal + the tag_added trigger), so there's no
    // per-message automation racing the AI to send.

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff, interest, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })

    // We actually replied — now reconcile the follow-up clock. Awaited
    // (we're already past the customer send, inside the webhook's after()
    // block, so this adds no customer-facing latency) so its tag write is
    // committed before the re-arm reads it back. Every reply from an
    // interested lead restarts the 12h→24h→48h cascade from now.
    await reconcileFollowup({
      db,
      accountId,
      userId: configOwnerUserId,
      contactId,
      interest,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
