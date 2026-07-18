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
  // Approved UTILITY feedback-survey templates (post-call follow-ups).
  { tagName: 'Interested Lead - Both AI', templateName: 'ai_both_feedback_survey' },
  { tagName: 'Interested Lead - AI Voice Agent', templateName: 'ai_voice_feedback_survey' },
  { tagName: 'Interested Lead - AI Content', templateName: 'ai_content_video_feedback_survey' },
  // No cold-outreach template exists right now (old marketing one was
  // deleted on Meta). The route stays so the button re-enables the
  // moment a template with this name is created + approved.
  { tagName: 'Cold Lead', templateName: 'cold_outreach_dental' },
  // Test contacts (kunal / Bikram) get the approved voice survey.
  { tagName: 'test_broadcast', templateName: 'ai_voice_feedback_survey' },
];

/** Resolve the template for a contact's tag names, or null if none map. */
export function resolveTemplateForTags(tagNames: string[]): string | null {
  const lower = new Set(tagNames.map((n) => n.trim().toLowerCase()));
  for (const route of TAG_TEMPLATE_ROUTES) {
    if (lower.has(route.tagName.toLowerCase())) return route.templateName;
  }
  return null;
}
