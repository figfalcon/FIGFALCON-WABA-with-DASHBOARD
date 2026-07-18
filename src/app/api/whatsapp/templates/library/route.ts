import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Meta Template Library proxy.
 *
 * GET  — browse/search Meta's pre-vetted library (mostly UTILITY
 *        templates: reminders, confirmations, feedback surveys).
 * POST — create a template on the WABA from a library entry
 *        (library_template_name), then mirror it locally. Library
 *        creations are usually approved instantly since Meta wrote
 *        the copy.
 */

const GRAPH = 'https://graph.facebook.com/v21.0'

async function resolveAccess() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return {
      error: NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      ),
    }
  }
  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single()
  if (!config) {
    return {
      error: NextResponse.json({ error: 'WhatsApp not configured.' }, { status: 400 }),
    }
  }
  return {
    supabase,
    user,
    accountId,
    config,
    accessToken: decrypt(config.access_token),
  }
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccess()
    if ('error' in access) return access.error

    const { searchParams } = new URL(request.url)
    const params = new URLSearchParams({ limit: '25', language: 'en_US' })
    const search = searchParams.get('search')?.trim()
    if (search) params.set('search', search)
    const topic = searchParams.get('topic')?.trim()
    if (topic) params.set('topic', topic)

    const res = await fetch(`${GRAPH}/message_template_library?${params}`, {
      headers: { Authorization: `Bearer ${access.accessToken}` },
    })
    const json = await res.json()
    if (!res.ok) {
      return NextResponse.json(
        { error: json?.error?.message ?? 'Library request failed.' },
        { status: 502 },
      )
    }
    return NextResponse.json({ data: json.data ?? [] })
  } catch (error) {
    console.error('Error browsing template library:', error)
    return NextResponse.json({ error: 'Failed to browse library.' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccess()
    if ('error' in access) return access.error
    const { supabase, user, accountId, config, accessToken } = access

    const body = (await request.json()) as {
      name?: string
      library_template_name?: string
      language?: string
      /** For library entries with a URL button — the site to open. */
      button_url?: string
    }
    const name = body.name?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    const libraryName = body.library_template_name?.trim()
    if (!name || !libraryName) {
      return NextResponse.json(
        { error: 'name and library_template_name are required.' },
        { status: 400 },
      )
    }
    const language = body.language?.trim() || 'en_US'

    // Fetch the library entry so we can mirror its body locally and
    // know whether it carries a URL button that needs an input.
    const libRes = await fetch(
      `${GRAPH}/message_template_library?name=${encodeURIComponent(libraryName)}&language=${language}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    const libJson = await libRes.json()
    const entry = (libJson.data ?? [])[0] as
      | {
          body?: string
          body_params?: string[]
          buttons?: { type: string; text?: string; url?: string; phone_number?: string }[]
        }
      | undefined
    if (!entry) {
      return NextResponse.json(
        { error: `Library template "${libraryName}" not found.` },
        { status: 404 },
      )
    }

    const payload: Record<string, unknown> = {
      name,
      language,
      category: 'UTILITY',
      library_template_name: libraryName,
    }
    const urlButtons = (entry.buttons ?? []).filter((b) => b.type === 'URL')
    if (urlButtons.length > 0) {
      if (!body.button_url?.trim()) {
        return NextResponse.json(
          { error: 'This library template has a URL button — provide button_url.' },
          { status: 400 },
        )
      }
      payload.library_template_button_inputs = urlButtons.map(() => ({
        type: 'URL',
        url: { base_url: body.button_url!.trim() },
      }))
    }

    const createRes = await fetch(`${GRAPH}/${config.waba_id}/message_templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const created = await createRes.json()
    if (!createRes.ok || !created.id) {
      const err = created?.error
      const detail = [err?.error_user_title, err?.error_user_msg].filter(Boolean).join(': ')
      return NextResponse.json(
        { error: detail || err?.message || 'Meta rejected the library creation.' },
        { status: 502 },
      )
    }

    // Mirror locally, with the library body (placeholders intact) and
    // the chosen button URL.
    const buttons =
      (entry.buttons ?? []).map((b) =>
        b.type === 'URL'
          ? { type: 'URL', text: b.text ?? 'Open', url: body.button_url!.trim() }
          : b,
      ) ?? null
    const sample = Object.fromEntries(
      (entry.body_params ?? []).map((v, i) => [String(i + 1), v]),
    )
    const { data: row, error: upsertErr } = await supabase
      .from('message_templates')
      .upsert(
        {
          account_id: accountId,
          user_id: user.id,
          name,
          language,
          category: 'Utility',
          status: created.status === 'APPROVED' ? 'APPROVED' : 'PENDING',
          body_text: entry.body ?? '',
          buttons: buttons && buttons.length > 0 ? buttons : null,
          sample_values: Object.keys(sample).length > 0 ? sample : null,
          meta_template_id: created.id,
          submission_error: null,
          last_submitted_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,name,language' },
      )
      .select()
      .single()
    if (upsertErr) {
      return NextResponse.json(
        {
          error: `Created on Meta but failed to save locally: ${upsertErr.message}. Run "Sync from Meta".`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, template: row, meta_status: created.status })
  } catch (error) {
    console.error('Error creating from template library:', error)
    return NextResponse.json({ error: 'Failed to create from library.' }, { status: 500 })
  }
}
