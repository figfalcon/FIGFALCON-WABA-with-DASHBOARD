import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import type { GenerateResult } from './types'
import {
  buildSystemPrompt,
  SERVICE_CODES,
  type ServiceFocus,
} from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { calcomConfigured, createCalBooking, formatIstTime } from '@/lib/calcom'
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

/**
 * Silent interest re-judgement when a human hands a thread back to the
 * bot ("Resume AI"). The manual conversation may have flipped the
 * lead's interest either way, and if the human's message was the last
 * one there is no inbound to trigger a normal dispatch — so without
 * this, an interested lead would get no follow-up cascade until they
 * happened to message again.
 *
 * Reads the visible context (manual/human turns included — they map to
 * the assistant role), asks the model ONLY for an interest verdict
 * (nothing is sent to the customer), then reconciles the tag + the
 * 12h→24h→48h cascade exactly like a normal post-reply pass:
 *   interested → tag + fresh cascade armed from now
 *   not interested → tag dropped + cascade cancelled
 *   unclear → keep whatever state the thread already had (an already-
 *   tagged lead still gets a fresh cascade; an untagged one stays off).
 *
 * Best-effort: never throws — a failed judgement leaves the thread in
 * its previous state.
 */
export async function judgeInterestOnResume(args: {
  accountId: string
  conversationId: string
  /** Used as tag-creator / audit user for the reconcile pass. */
  userId: string
}): Promise<void> {
  const { accountId, conversationId, userId } = args
  try {
    const db = supabaseAdmin()
    const config = await loadAiConfig(db, accountId)
    if (!config) return

    const { data: conv } = await db
      .from('conversations')
      .select('contact_id, ai_context_reset_at')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv?.contact_id) return

    const messages = await buildConversationContext(
      db,
      conversationId,
      undefined,
      (conv.ai_context_reset_at as string | null) ?? null,
    )
    if (messages.length === 0) return

    const { interest, usage } = await generateReply({
      config,
      systemPrompt:
        'You are auditing a WhatsApp sales conversation between a business (assistant — including turns written manually by a human agent) and a lead (user). ' +
        "Decide the lead's CURRENT interest in the business's services from the whole conversation, weighing the latest turns most. " +
        'Reply with exactly [[INTERESTED]] if they are clearly interested or agreed to move forward, exactly [[NOT_INTERESTED]] if they clearly declined or opted out, or exactly UNCLEAR if neither is clear. Output nothing else.',
      messages,
    })

    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    await reconcileFollowup({
      db,
      accountId,
      userId,
      contactId: conv.contact_id as string,
      interest,
    })
  } catch (err) {
    console.error('[ai auto-reply] resume judgement failed:', err)
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
      .select(
        'assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_service_focus, ai_context_reset_at',
      )
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here

    let replyCount: number = conv.ai_reply_count ?? 0
    let serviceFocus = (conv.ai_service_focus ?? null) as ServiceFocus | null
    let contextSince: string | null = conv.ai_context_reset_at ?? null

    // Session-based reply budget: the cap bounds one ACTIVE burst of
    // conversation, not the thread's lifetime. If the previous message
    // in the thread is over an hour old, the lead is re-engaging after
    // a gap — treat it as a new session and refund the full budget.
    // Best-effort: on any error we just keep the current count.
    try {
      const { data: recent } = await db
        .from('messages')
        .select('created_at, content_text, sender_type')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(2)
      const prev = recent?.[1]
      if (
        replyCount > 0 &&
        prev?.created_at &&
        Date.now() - new Date(prev.created_at as string).getTime() >
          60 * 60 * 1000
      ) {
        replyCount = 0
        await db
          .from('conversations')
          .update({ ai_reply_count: 0 })
          .eq('id', conversationId)
      }

      // `reset` keyword: wipe the AI's memory of this thread. Message
      // history stays in the inbox; the model just stops seeing anything
      // before this point, drops any specialist focus, and gets a fresh
      // budget — it greets the lead like a brand-new contact.
      const latest = recent?.[0]
      if (
        latest?.sender_type === 'customer' &&
        typeof latest.content_text === 'string' &&
        latest.content_text.trim().toLowerCase() === 'reset'
      ) {
        const nowIso = new Date().toISOString()
        contextSince = nowIso
        serviceFocus = null
        replyCount = 0
        await db
          .from('conversations')
          .update({
            ai_context_reset_at: nowIso,
            ai_service_focus: null,
            ai_reply_count: 0,
          })
          .eq('id', conversationId)
      }
    } catch (err) {
      console.error('[ai auto-reply] session/reset check failed:', err)
    }

    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (replyCount >= config.autoReplyMaxPerConversation) return

    let messages = await buildConversationContext(
      db,
      conversationId,
      undefined,
      contextSince,
    )
    // Right after a reset the filtered context is empty (the `reset`
    // message itself is excluded). Seed a plain greeting turn so the
    // model opens fresh instead of staying silent.
    if (messages.length === 0 && contextSince) {
      messages = [{ role: 'user', content: 'hi' }]
    }
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

    // The customer's known name (WhatsApp profile name lands on the
    // contact automatically) — lets the agent greet them personally.
    // Placeholder names (bare phone numbers) are filtered out.
    let contactName: string | null = null
    let contactPhone: string | null = null
    let contactCompany: string | null = null
    try {
      const { data: contactRow } = await db
        .from('contacts')
        .select('name, phone, company')
        .eq('id', contactId)
        .maybeSingle()
      contactPhone = contactRow?.phone ?? null
      contactCompany = contactRow?.company ?? null
      const rawName = contactRow?.name?.trim() ?? ''
      if (
        rawName &&
        rawName !== contactRow?.phone &&
        !/^\+?[\d\s()-]+$/.test(rawName)
      ) {
        contactName = rawName
      }
    } catch {
      // best-effort — a lookup failure must never block the reply
    }

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      serviceFocus,
      contactName,
      bookingEnabled: calcomConfigured(),
    })

    // LLM call with escalating retries: attempt 1 → wait 10s → attempt 2
    // → wait 30s → attempt 3 → give up to the deterministic fallback.
    // The pauses matter: the most common failure is the provider key's
    // own rate limit (429) under a burst of messages, which clears after
    // seconds — an immediate retry would just hit the same wall. A
    // transient error must never leave the customer unanswered.
    const RETRY_WAITS_MS = [10_000, 30_000]
    let gen: GenerateResult | null = null
    for (let attempt = 0; attempt < 3 && !gen; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, RETRY_WAITS_MS[attempt - 1]))
      }
      try {
        gen = await generateReply({ config, systemPrompt, messages })
      } catch (err) {
        console.error(
          `[ai auto-reply] generate attempt ${attempt + 1} failed:`,
          err,
        )
      }
    }
    // Both attempts failed → deterministic fallback so the lead still
    // gets SOMETHING instead of dead air. No usage to log (no response).
    const { text: rawText, handoff, interest, service, usage } = gen ?? {
      text: '',
      handoff: false,
      interest: undefined,
      service: undefined,
      usage: null,
    }

    // Persist a routing change the model signalled: a service code
    // focuses the thread on that specialist playbook from the next turn;
    // GLOBAL hands back to the generalist. Best-effort.
    if (service) {
      const next: ServiceFocus | null =
        service === 'GLOBAL' ? null : (SERVICE_CODES[service] ?? serviceFocus)
      if (next !== serviceFocus) {
        void db
          .from('conversations')
          .update({ ai_service_focus: next })
          .eq('id', conversationId)
          .then(({ error }) => {
            if (error)
              console.error('[ai auto-reply] focus update failed:', error)
          })
      }
    }

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

    if (handoff) {
      // The model explicitly asked for a human — stop auto-replying on
      // this thread and hand it off. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount,
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

    // Deterministic output hygiene: the em/en dash reads as AI-generated,
    // so it is mechanically stripped no matter what the model produced.
    let text = rawText
      .replace(/\s*[—–]\s*/g, ', ')
      .trim()
    // Empty text without a handoff (model glitch or both attempts
    // failed) → safe fallback instead of silence. The always-reply
    // guarantee outranks eloquence.
    if (!text) {
      text = "Sorry, I think my last message didn't go through. What were you saying?"
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

    // Booking marker → book on cal.com and send the outcome as its own
    // message. The AI's text has already told the lead "booking now";
    // this follow-up is the system's truthful confirmation or a
    // pick-another-time fallback — the AI never claims success itself.
    const booking = gen?.booking
    if (booking && calcomConfigured()) {
      const startIso = `${booking.start}:00+05:30`
      const result = await createCalBooking({
        startIso,
        name: contactName ?? 'WhatsApp Lead',
        email: booking.email,
        phone: contactPhone,
        company: contactCompany,
      })
      const followText = result.ok
        ? `✅ Booked! Your call is confirmed for ${formatIstTime(result.startIso)}.\n\nCalendar invite sent to ${booking.email}.${result.meetUrl ? `\nMeeting link: ${result.meetUrl}` : ''}\n\nSee you there!`
        : `I couldn't book that slot, it may already be taken. You can pick any free time here: https://cal.com/figfalcon/figfalcon-strategy-call or reply with another day and time and I'll try again.`
      if (!result.ok) {
        console.error('[ai auto-reply] cal.com booking failed:', result.error)
      }
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: followText,
        aiGenerated: true,
      })
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
