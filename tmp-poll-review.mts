import { readFileSync } from 'node:fs'
const envText = readFileSync('.env.local', 'utf8').replace(/^﻿/, '').replace(/\r/g, '')
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].trim()
}
const { createClient } = await import('@supabase/supabase-js')
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const { decrypt } = await import('./src/lib/whatsapp/encryption')
const { data: cfg } = await db.from('whatsapp_config').select('*').limit(1).single()
const token = decrypt(cfg.access_token)
for (let i = 0; i < 10; i++) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/1033940965716450?fields=name,category,status,rejected_reason`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const t = await res.json()
  console.log(`[${i * 20}s] status: ${t.status} | category: ${t.category}${t.rejected_reason && t.rejected_reason !== 'NONE' ? ' | rejected: ' + t.rejected_reason : ''}`)
  if (t.status !== 'PENDING') break
  await new Promise((r) => setTimeout(r, 20_000))
}
