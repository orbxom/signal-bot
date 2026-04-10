import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalClient } from '../src/signalClient';

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    group: vi.fn(),
    step: vi.fn(),
    groupEnd: vi.fn(),
    compact: vi.fn(),
  },
}));

describe('SignalClient.fetchAttachment', () => {
  let client: SignalClient;
  const baseUrl = 'http://localhost:8080';

  beforeEach(() => {
    client = new SignalClient(baseUrl, '+1234567890');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return Buffer when HTTP returns valid base64 JSON', async () => {
    const imageData = Buffer.from('fake image data');
    const base64 = imageData.toString('base64');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: base64 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await client.fetchAttachment('att-123');

    expect(result).toBeInstanceOf(Buffer);
    expect(result).toEqual(imageData);
  });

  it('should call correct URL', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: 'AAAA' }), { status: 200 }));

    await client.fetchAttachment('att-456');

    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/v1/attachments/att-456`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should return null on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }));

    const result = await client.fetchAttachment('missing-id');

    expect(result).toBeNull();
  });

  it('should return null on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await client.fetchAttachment('att-123');

    expect(result).toBeNull();
  });

  it('should return null when response JSON has no data field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'no such attachment' }), { status: 200 }),
    );

    const result = await client.fetchAttachment('att-123');

    expect(result).toBeNull();
  });

  it('should return null when response is not valid JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));

    const result = await client.fetchAttachment('att-123');

    expect(result).toBeNull();
  });
});
