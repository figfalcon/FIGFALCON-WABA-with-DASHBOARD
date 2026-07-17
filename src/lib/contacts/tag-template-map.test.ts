import { describe, expect, it } from 'vitest';
import { resolveTemplateForTags } from './tag-template-map';

describe('resolveTemplateForTags', () => {
  it('routes each interest tag to its template', () => {
    expect(resolveTemplateForTags(['Interested Lead - AI Voice Agent'])).toBe(
      'ai_voice_reciptionist_picked_call_interested',
    );
    expect(resolveTemplateForTags(['Interested Lead - AI Content'])).toBe(
      'ai_video_content',
    );
    expect(resolveTemplateForTags(['Cold Lead'])).toBe(
      'ai_voice_reciption_and_whatsapp_unpicked_calls',
    );
    expect(resolveTemplateForTags(['test_broadcast'])).toBe(
      'demo_call_followup_booking',
    );
  });

  it('prefers Both AI over single-service tags', () => {
    expect(
      resolveTemplateForTags([
        'Interested Lead - AI Content',
        'Interested Lead - Both AI',
      ]),
    ).toBe('both_ai_automation_ai_content_growth_intrested');
  });

  it('matches case-insensitively and ignores unrelated tags', () => {
    expect(resolveTemplateForTags(['cold lead', 'Awaiting Follow-up'])).toBe(
      'ai_voice_reciption_and_whatsapp_unpicked_calls',
    );
  });

  it('returns null when no tag maps', () => {
    expect(resolveTemplateForTags(['Awaiting Follow-up'])).toBeNull();
    expect(resolveTemplateForTags([])).toBeNull();
  });
});
