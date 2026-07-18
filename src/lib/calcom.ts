// ============================================================
// Cal.com v2 API — real appointment booking for the AI agent.
//
// The AI emits a [[BOOK:datetime|email]] marker (see defaults.ts);
// the auto-reply pipeline calls createCalBooking and then sends the
// customer a confirmation (or a pick-another-time message). The AI
// itself never talks to cal.com and never claims success — only the
// system's follow-up message does.
//
// Required env: CALCOM_API_KEY, CALCOM_EVENT_TYPE_ID.
// The event type's required booking fields beyond name/email are
// auto-filled with defaults (overridable via env) so a WhatsApp
// lead doesn't have to answer a seven-field qualification form.
// ============================================================

const CAL_API = 'https://api.cal.com/v2'

export interface CalBookingArgs {
  /** Full ISO start time, e.g. 2026-07-21T15:00:00+05:30 */
  startIso: string
  name: string
  email: string
  phone?: string | null
  company?: string | null
  /** Qualification answers the AI collected in-chat; env defaults fill gaps. */
  industry?: string | null
  teamSize?: string | null
  budget?: string | null
}

export type CalBookingResult =
  | { ok: true; startIso: string; meetUrl: string | null }
  | { ok: false; error: string }

export function calcomConfigured(): boolean {
  return Boolean(process.env.CALCOM_API_KEY && process.env.CALCOM_EVENT_TYPE_ID)
}

export async function createCalBooking(
  args: CalBookingArgs,
): Promise<CalBookingResult> {
  const apiKey = process.env.CALCOM_API_KEY
  const eventTypeId = Number(process.env.CALCOM_EVENT_TYPE_ID)
  if (!apiKey || !Number.isFinite(eventTypeId)) {
    return { ok: false, error: 'Booking is not configured.' }
  }

  try {
    const res = await fetch(`${CAL_API}/bookings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': '2024-08-13',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        start: new Date(args.startIso).toISOString(),
        eventTypeId,
        attendee: {
          name: args.name,
          email: args.email,
          timeZone: 'Asia/Kolkata',
          ...(args.phone ? { phoneNumber: args.phone } : {}),
        },
        // Defaults for the event type's extra REQUIRED fields — a
        // WhatsApp lead shouldn't face the full qualification form.
        bookingFieldsResponses: {
          title: 'AI Demo Call (WhatsApp)',
          company_name: args.company || 'Not provided',
          'Industry-Business-Type':
            args.industry || process.env.CALCOM_DEFAULT_INDUSTRY || 'Healthcare',
          Company_size:
            args.teamSize || process.env.CALCOM_DEFAULT_COMPANY_SIZE || 'Solo',
          budget: args.budget || process.env.CALCOM_DEFAULT_BUDGET || '$800-$3,000',
          notes: 'Booked automatically via the WhatsApp AI assistant.',
        },
        metadata: { source: 'wacrm-ai' },
      }),
    })
    const json = (await res.json()) as {
      data?: { uid?: string; start?: string; meetingUrl?: string; location?: string }
      error?: { message?: string }
    }
    if (!res.ok || !json.data?.uid) {
      return {
        ok: false,
        error: json.error?.message ?? `Booking failed (HTTP ${res.status}).`,
      }
    }
    const location = json.data.location
    return {
      ok: true,
      startIso: json.data.start ?? args.startIso,
      meetUrl:
        json.data.meetingUrl ??
        (typeof location === 'string' && location.startsWith('http')
          ? location
          : null),
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Booking request failed.',
    }
  }
}

/** "Monday, 21 July, 3:00 pm IST" — customer-facing confirmation time. */
export function formatIstTime(iso: string): string {
  const d = new Date(iso)
  const datePart = d.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
  const timePart = d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  return `${datePart}, ${timePart} IST`
}
