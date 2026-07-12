import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the automations engine so we can assert what the reconcile does
// (cancel pending, re-arm the cascade) without touching a real DB/engine.
const eng = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(async () => {}),
  cancelPendingAutomationRuns: vi.fn(async () => {}),
}))
vi.mock('@/lib/automations/engine', () => eng)

// Minimal fake supabase client covering the two tables reconcile touches:
//   tags          → get-or-create the "Interested Lead" tag (returns TAG_ID)
//   contact_tags  → upsert / delete / count (is the contact tagged?)
const TAG_ID = 'tag-interested'
function fakeDb(opts: { tagged: boolean }) {
  const calls = { upsert: 0, delete: 0 }
  const client = {
    from(table: string) {
      if (table === 'tags') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: { id: TAG_ID } }) }),
            }),
          }),
        }
      }
      // contact_tags
      return {
        upsert: async () => {
          calls.upsert++
          return { error: null }
        },
        delete: () => ({
          eq: () => ({ eq: async () => { calls.delete++; return { error: null } } }),
        }),
        select: () => ({
          eq: () => ({
            eq: async () => ({ count: opts.tagged ? 1 : 0 }),
          }),
        }),
      }
    },
  }
  return { client, calls }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { reconcileFollowup } from './auto-reply'

const BASE = { accountId: 'acct-1', userId: 'user-1', contactId: 'contact-1' }

beforeEach(() => {
  eng.runAutomationsForTrigger.mockClear()
  eng.cancelPendingAutomationRuns.mockClear()
})

describe('reconcileFollowup', () => {
  it('interest="no" drops the tag and cancels, never re-arms', async () => {
    const { client, calls } = fakeDb({ tagged: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileFollowup({ db: client as any, ...BASE, interest: 'no' })
    expect(calls.delete).toBe(1)
    expect(eng.cancelPendingAutomationRuns).toHaveBeenCalledTimes(1)
    expect(eng.runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('interest="yes" tags then re-arms a fresh cascade', async () => {
    const { client, calls } = fakeDb({ tagged: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileFollowup({ db: client as any, ...BASE, interest: 'yes' })
    expect(calls.upsert).toBe(1)
    expect(eng.cancelPendingAutomationRuns).toHaveBeenCalledTimes(1)
    expect(eng.runAutomationsForTrigger).toHaveBeenCalledTimes(1)
    expect(eng.runAutomationsForTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: 'tag_added', contactId: 'contact-1' }),
    )
  })

  it('neutral turn on an already-interested lead re-arms (restarts the clock)', async () => {
    const { client } = fakeDb({ tagged: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileFollowup({ db: client as any, ...BASE })
    // The lead ghosting again → a fresh cascade is armed from now.
    expect(eng.cancelPendingAutomationRuns).toHaveBeenCalledTimes(1)
    expect(eng.runAutomationsForTrigger).toHaveBeenCalledTimes(1)
  })

  it('neutral turn on a non-interested lead does nothing', async () => {
    const { client } = fakeDb({ tagged: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reconcileFollowup({ db: client as any, ...BASE })
    expect(eng.runAutomationsForTrigger).not.toHaveBeenCalled()
  })
})
