import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTokenSessionStore } from '@smes/product-ui';

const backing = new Map<string, string>();
const storage: Storage = {
  getItem: key => backing.get(key) ?? null,
  setItem: (key, value) => { backing.set(key, value); },
  removeItem: key => { backing.delete(key); }, clear: () => backing.clear(), key: () => null,
  get length() { return backing.size; },
};
const assign = vi.fn();
vi.stubGlobal('window', { localStorage: storage, location: { pathname: '/drawings', assign } });
const session = createBrowserTokenSessionStore(storage);
const { requestBytes, authInFlightCount } = await import('../src/data/apiClient');
const { loadDrawingPdf, uploadDrawingPdf } = await import('../src/pages/drawing/drawingApi');
const bytes = new TextEncoder().encode('%PDF-1.4\nisolated binary fixture');
function login(token = 'original') {
  session.write({ userId: 'reader' as never, tenantId: 'default' as never, displayName: 'reader', permissions: [], token, expiresAt: '2026-11-05T00:00:00Z' });
}
beforeEach(() => { backing.clear(); assign.mockClear(); login(); });

describe('authenticated drawing PDF fetch', () => {
  it('uploads the same PDF bytes associated with the requested drawing through existing attachment permission', async () => {
    vi.stubGlobal('FileReader', class {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then(buffer => {
          this.result = `data:application/pdf;base64,${Buffer.from(buffer).toString('base64')}`;
          this.onload?.();
        });
      }
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'atc-isolated' })));
    vi.stubGlobal('fetch', fetcher);
    expect(await uploadDrawingPdf('part-A', new File([bytes], 'part.pdf', { type: 'application/pdf' }))).toBe('attachment:atc-isolated');
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/attachment/upload');
    expect(JSON.parse(String(call[1].body))).toMatchObject({ bizType: 'drawing-pdf', bizId: 'part-A', contentType: 'application/pdf', contentBase64: Buffer.from(bytes).toString('base64') });
  });
  it('fetches exact bytes with bearer, pinned revision, clearance and no-store', async () => {
    const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await loadDrawingPdf('part A/1', 3, 'restricted', new AbortController().signal)).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledWith('/drawing/revisions/part%20A%2F1/content?version=3&clearance=restricted', expect.objectContaining({ cache: 'no-store', headers: expect.objectContaining({ authorization: 'Bearer original' }) }));
    expect(authInFlightCount()).toBe(0);
  });
  it('keeps the session on permission rejection and retains the server error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'denied', code: 'drawing.not_found' }), { status: 403 })));
    await expect(requestBytes('/content')).rejects.toMatchObject({ status: 403, code: 'drawing.not_found', message: 'denied' });
    expect(session.read()?.token).toBe('original');
    expect(assign).not.toHaveBeenCalled();
  });
  it('retries a refresh race once and still decodes the retry as bytes', async () => {
    const fetcher = vi.fn().mockImplementationOnce(async () => { login('refreshed'); return new Response('{}', { status: 401 }); })
      .mockImplementationOnce(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    expect(await requestBytes('/content')).toEqual(bytes);
    expect(fetcher.mock.calls[1]?.[1].headers.authorization).toBe('Bearer refreshed');
    expect(session.read()?.token).toBe('refreshed');
  });
  it('clears an actually rejected session and redirects without treating error JSON as PDF', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(requestBytes('/content')).rejects.toMatchObject({ status: 401 });
    expect(session.read()).toBeNull();
    expect(assign).toHaveBeenCalledWith('/login');
    expect(authInFlightCount()).toBe(0);
  });
});
