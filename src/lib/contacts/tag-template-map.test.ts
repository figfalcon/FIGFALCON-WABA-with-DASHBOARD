import { describe, expect, it } from 'vitest';
import { resolveTemplateForTags } from './tag-template-map';

describe('resolveTemplateForTags', () => {
  it('routes each interest tag to its template', () => {
    expect(resolveTemplateForTags(['Interested Lead - AI Voice Agent'])).toBe(
      'ai_voice_feedback_survey',
    );
    expect(resolveTemplateForTags(['Interested Lead - AI Content'])).toBe(
      'ai_content_video_feedback_survey',
    );
    expect(resolveTemplateForTags(['Cold Lead'])).toBe('cold_outreach_dental');
    expect(resolveTemplateForTags(['test_broadcast'])).toBe(
      'ai_voice_feedback_survey',
    );
  });

  it('prefers Both AI over single-service tags', () => {
    expect(
      resolveTemplateForTags([
        'Interested Lead - AI Content',
        'Interested Lead - Both AI',
      ]),
    ).toBe('ai_both_feedback_survey');
  });

  it('matches case-insensitively and ignores unrelated tags', () => {
    expect(resolveTemplateForTags(['cold lead', 'Awaiting Follow-up'])).toBe(
      'cold_outreach_dental',
    );
  });

  it('returns null when no tag maps', () => {
    expect(resolveTemplateForTags(['Awaiting Follow-up'])).toBeNull();
    expect(resolveTemplateForTags([])).toBeNull();
  });
});
