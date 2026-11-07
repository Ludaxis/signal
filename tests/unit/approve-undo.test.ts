// Approve with Undo: the client-side 8 s hold, Undo inside it, and the flush on pagehide
//. Nothing here reaches a server: `send` is a stub.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferApprove, isApproving } from '@/app/studio/approve-undo';
import { TOAST_UNDO_MS } from '@/app/studio/ui/Toast';

afterEach(() => {
  vi.useRealTimers();
});

describe('Approve with Undo', () => {
  it('holds the approval for 8 s, then sends it without keepalive', async () => {
    vi.useFakeTimers();
    expect(TOAST_UNDO_MS).toBe(8000);
    const send = vi.fn(async () => undefined);
    deferApprove('a1', send, () => undefined);
    expect(isApproving('a1')).toBe(true);
    vi.advanceTimersByTime(TOAST_UNDO_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith({ keepalive: false });
    expect(isApproving('a1')).toBe(false);
  });

  it('Undo inside the hold sends nothing', () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    const undo = deferApprove('a2', send, () => undefined);
    expect(undo()).toBe(true);
    vi.advanceTimersByTime(TOAST_UNDO_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });

  it('pagehide sends every waiting approval at once, with keepalive', () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    const undo = deferApprove('a3', send, () => undefined);
    window.dispatchEvent(new Event('pagehide'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ keepalive: true });
    expect(undo()).toBe(false);
    vi.advanceTimersByTime(TOAST_UNDO_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
