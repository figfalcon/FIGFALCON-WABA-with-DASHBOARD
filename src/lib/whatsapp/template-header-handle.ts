import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with a MEDIA header — image, video, or
 * document. A plain public URL is not accepted at creation time: Meta
 * rejects it with a bare "Invalid parameter". This helper turns the
 * template's `header_media_url` (whether the user uploaded a file or
 * pasted a link) into a handle and writes it onto the payload.
 *
 * No-op unless the header is media that has a URL but no handle yet.
 */

// Meta's per-format sample limits + accepted MIME types.
const MEDIA_RULES = {
  image: {
    maxBytes: 5 * 1024 * 1024,
    types: ['image/jpeg', 'image/png'],
    fallbackType: 'image/jpeg',
    label: 'JPEG or PNG',
  },
  video: {
    maxBytes: 16 * 1024 * 1024,
    types: ['video/mp4', 'video/3gpp'],
    fallbackType: 'video/mp4',
    label: 'MP4 or 3GPP',
  },
  document: {
    maxBytes: 100 * 1024 * 1024,
    types: ['application/pdf'],
    fallbackType: 'application/pdf',
    label: 'PDF',
  },
} as const

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
}

type MediaHeader = keyof typeof MEDIA_RULES

function isMediaHeader(t: TemplatePayload['header_type']): t is MediaHeader {
  return t === 'image' || t === 'video' || t === 'document'
}

export async function ensureMediaHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  if (!isMediaHeader(payload.header_type)) return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const kind = payload.header_type
  const rules = MEDIA_RULES[kind]

  const appId = process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      `${kind}-header templates need META_APP_ID set (used for Meta’s Resumable Upload). Add it to your environment, or remove the ${kind} header.`,
    )
  }

  // Fetch the sample bytes (works for our uploaded chat-media URL and for
  // a manually-pasted public link).
  let res: Response
  try {
    res = await fetch(payload.header_media_url, { redirect: 'follow' })
  } catch {
    throw new Error(
      `Could not fetch the header ${kind} URL. Make sure it is publicly reachable.`,
    )
  }
  if (!res.ok) {
    throw new Error(
      `Header ${kind} URL returned ${res.status}. It must be publicly reachable.`,
    )
  }

  const contentType = (res.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase()

  // A page (YouTube/Drive/Vimeo link, or an HTML error page) is the most
  // common mistake here — Meta needs the raw media FILE, not a page that
  // plays it. Say so explicitly instead of letting Meta answer with an
  // opaque "Invalid parameter".
  if (contentType.startsWith('text/') || contentType === 'application/xhtml+xml') {
    throw new Error(
      `That link returns a web page, not a ${kind} file. Meta needs a direct link to the ${rules.label} file itself (the URL should end in .${EXTENSIONS[rules.fallbackType]}). Sharing links like YouTube, Google Drive, or Vimeo will not work — upload the file instead.`,
    )
  }
  if (contentType && !(rules.types as readonly string[]).includes(contentType)) {
    throw new Error(
      `Header ${kind} must be ${rules.label} (got ${contentType}).`,
    )
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error(`Header ${kind} is empty.`)
  }
  if (bytes.byteLength > rules.maxBytes) {
    throw new Error(
      `Header ${kind} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — Meta's limit is ${rules.maxBytes / 1024 / 1024} MB.`,
    )
  }

  const mimeType = (rules.types as readonly string[]).includes(contentType)
    ? contentType
    : rules.fallbackType
  const fileName = `header.${EXTENSIONS[mimeType] ?? 'bin'}`

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}
