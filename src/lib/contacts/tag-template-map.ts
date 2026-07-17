/**
 * Tag → outreach-template routing for the one-click "Send template"
 * button on the Contacts page.
 *
 * A contact's tags decide which approved template the button sends.
 * Checked in priority order (a lead interested in BOTH systems must
 * get the combined pitch even if they also carry a single-service
 * tag); first match wins. Matching is case-insensitive on tag name.
 */
export const TAG_TEMPLATE_ROUTES: { tagName: string; templateName: string }[] = [
  { tagName: 'Interested Lead - Both AI', templateName: 'both_ai_automation_ai_content_growth_intrested' },
  { tagName: 'Interested Lead - AI Voice Agent', templateName: 'ai_voice_reciptionist_picked_call_interested' },
  { tagName: 'Interested Lead - AI Content', templateName: 'ai_video_content' },
  { tagName: 'Cold Lead', templateName: 'ai_voice_reciption_and_whatsapp_unpicked_calls' },
  { tagName: 'test_broadcast', templateName: 'demo_call_followup_booking' },
];

/** Resolve the template for a contact's tag names, or null if none map. */
export function resolveTemplateForTags(tagNames: string[]): string | null {
  const lower = new Set(tagNames.map((n) => n.trim().toLowerCase()));
  for (const route of TAG_TEMPLATE_ROUTES) {
    if (lower.has(route.tagName.toLowerCase())) return route.templateName;
  }
  return null;
}
