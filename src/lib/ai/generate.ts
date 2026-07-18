import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import {
  HANDOFF_SENTINEL,
  INTERESTED_SENTINEL,
  NOT_INTERESTED_SENTINEL,
  SERVICE_SENTINEL_RE,
  aiRequestTimeoutMs,
} from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
/** [[BOOK:datetime|email|company|industry|team size|budget]] marker. */
const BOOK_SENTINEL_RE =
  /\[\[BOOK:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\|([^\]|]+@[^\]|]+)\|([^\]|]+)\|([^\]|]+)\|([^\]|]+)\|([^\]|]+)\]\]/

export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  let interest: 'yes' | 'no' | undefined
  if (raw.includes(INTERESTED_SENTINEL)) interest = 'yes'
  else if (raw.includes(NOT_INTERESTED_SENTINEL)) interest = 'no'
  const service = SERVICE_SENTINEL_RE.exec(raw)?.[1]
  const bookMatch = BOOK_SENTINEL_RE.exec(raw)
  const booking = bookMatch
    ? {
        start: bookMatch[1],
        email: bookMatch[2].trim(),
        company: bookMatch[3].trim(),
        industry: bookMatch[4].trim(),
        teamSize: bookMatch[5].trim(),
        budget: bookMatch[6].trim(),
      }
    : undefined
  const text = raw
    .split(HANDOFF_SENTINEL)
    .join('')
    .split(INTERESTED_SENTINEL)
    .join('')
    .split(NOT_INTERESTED_SENTINEL)
    .join('')
    .replace(new RegExp(SERVICE_SENTINEL_RE.source, 'g'), '')
    .replace(new RegExp(BOOK_SENTINEL_RE.source, 'g'), '')
    .trim()
  return { text, handoff, interest, service, booking, usage }
}
