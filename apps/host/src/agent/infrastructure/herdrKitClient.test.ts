import { afterEach, expect, test, vi } from 'vitest';
import { KitHerdrClient } from './herdrKitClient.js';

// The host journal is the captain's own surface here: a slow sample has to be
// visible, and only a trend may throw the kit away.
const journal: string[] = [];
vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    journal.push(String(chunk));
    return true;
});

afterEach(() => {
    vi.useRealTimers();
    journal.length = 0;
});

/** A read that never settles is the wedge the restart exists for. */
function wedgedRead(): Promise<void> {
    return new Promise<void>(() => {});
}

test('one slow tree read keeps the Herdr kit; only a sustained one restarts it', async () => {
    vi.useFakeTimers();
    const client = new KitHerdrClient(() => 'herdr', '/nonexistent/herdr.sock', () => {});
    // The kit itself is not under test: count the restarts it is asked for.
    const kit = client.kit as unknown as { stop: () => Promise<void>; start: () => Promise<void>; refresh: () => Promise<void> };
    let restarts = 0;
    kit.stop = async () => { restarts += 1; };
    kit.start = async () => {};
    kit.refresh = async () => {};

    const guarded = (client as unknown as { guardRefresh: (read: Promise<void>) => Promise<void> }).guardRefresh(wedgedRead());

    await vi.advanceTimersByTimeAsync(20_000 + 50);
    expect(restarts, 'a single slow sample is a loaded machine, not a wedge').toBe(0);
    expect(journal.join('')).toContain('slow sample 1/3');
    expect(journal.join('')).not.toContain('restarting the herdr kit');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(restarts, 'two slow samples are still not a trend').toBe(0);

    await vi.advanceTimersByTimeAsync(20_000 + 50);
    await expect(guarded).resolves.toBeUndefined();
    expect(restarts, 'three slow samples in a row is the trend that breaks the kit').toBe(1);
    expect(journal.join('')).toContain('after 60s (3 slow samples in a row); restarting the herdr kit');
});
