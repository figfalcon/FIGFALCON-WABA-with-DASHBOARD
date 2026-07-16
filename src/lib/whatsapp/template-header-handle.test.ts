import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Meta resumable upload so the helper is tested in isolation.
vi.mock('./meta-api', () => ({
  uploadResumableMedia: vi.fn(async () => ({ handle: 'HANDLE123' })),
}));

import { ensureMediaHeaderHandle } from './template-header-handle';
import { uploadResumableMedia } from './meta-api';
import type { TemplatePayload } from './template-validators';

function payload(over: Partial<TemplatePayload> = {}): TemplatePayload {
  return {
    name: 't',
    category: 'Utility',
    language: 'en_US',
    body_text: 'hi',
    header_type: 'image',
    header_media_url: 'https://x.test/img.jpg',
    ...over,
  };
}

function imgResponse(type = 'image/jpeg', size = 1024, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as Response;
}

describe('ensureMediaHeaderHandle', () => {
  beforeEach(() => {
    vi.mocked(uploadResumableMedia).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is a no-op for non-media headers', async () => {
    const p = payload({ header_type: 'text', header_content: 'Hi' });
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('is a no-op when a handle already exists', async () => {
    const p = payload({ header_handle: 'existing' });
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBe('existing');
  });

  it('throws an actionable error when META_APP_ID is unset', async () => {
    const p = payload();
    await expect(ensureMediaHeaderHandle(p, 'tok')).rejects.toThrow(/META_APP_ID/);
  });

  it('derives + sets header_handle from a valid image URL', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/jpeg', 2048)));
    const p = payload();
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('rejects a wrong image content type', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/gif')));
    await expect(ensureMediaHeaderHandle(payload(), 'tok')).rejects.toThrow(/JPEG or PNG/);
  });

  it('rejects an image over 5 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/png', 6 * 1024 * 1024)));
    await expect(ensureMediaHeaderHandle(payload(), 'tok')).rejects.toThrow(/5 MB/);
  });

  // --- video headers (previously skipped entirely → Meta "Invalid parameter") ---

  const videoPayload = () =>
    payload({ header_type: 'video', header_media_url: 'https://x.test/clip.mp4' });

  it('derives + sets header_handle from a valid video URL', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('video/mp4', 2048)));
    const p = videoPayload();
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(vi.mocked(uploadResumableMedia).mock.calls[0][0]).toMatchObject({
      mimeType: 'video/mp4',
      fileName: 'header.mp4',
    });
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('explains that a page link (YouTube etc.) is not a video file', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('text/html')));
    const p = payload({ header_type: 'video', header_media_url: 'https://youtu.be/abc' });
    await expect(ensureMediaHeaderHandle(p, 'tok')).rejects.toThrow(/web page, not a video file/);
  });

  it('rejects a video over 16 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('video/mp4', 17 * 1024 * 1024)));
    await expect(ensureMediaHeaderHandle(videoPayload(), 'tok')).rejects.toThrow(/16 MB/);
  });

  it('derives + sets header_handle for a PDF document header', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('application/pdf', 4096)));
    const p = payload({ header_type: 'document', header_media_url: 'https://x.test/f.pdf' });
    await ensureMediaHeaderHandle(p, 'tok');
    expect(p.header_handle).toBe('HANDLE123');
  });
});
