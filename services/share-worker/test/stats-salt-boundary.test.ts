import { describe, expect, it } from 'vitest';
import { nextDayStart, StatsSalt, statsDay } from '../src/stats';
import { FakeDoStorage } from './fakes';

const BEFORE = Date.parse('2026-11-04T15:59:59.990Z');
const MIDNIGHT = Date.parse('2026-11-04T16:00:00.000Z');

// Only storage I/O advances this test clock. Synchronous clock reads agree,
// as on deployed Workers; no callback or wall-clock delay is fabricated.
class GatedStorage extends FakeDoStorage {
  readonly entered = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  constructor(private readonly phase: 'get' | 'put') { super(); }

  override async get<T>(key: string): Promise<T | undefined> {
    if (this.phase === 'get') {
      this.entered.resolve();
      await this.release.promise;
    }
    return super.get<T>(key);
  }

  override async put(key: string, value: unknown) {
    if (this.phase === 'put') {
      this.entered.resolve();
      await this.release.promise;
    }
    return super.put(key, value);
  }
}

function object(storage: FakeDoStorage, now: () => number): StatsSalt {
  const salt = new StatsSalt({ storage } as unknown as DurableObjectState);
  salt.now = now;
  return salt;
}

describe('daily salt expiry across storage I/O', () => {
  for (const phase of ['get', 'put'] as const) {
    it(`keeps the saved day's deadline when ${phase} crosses UTC+8 midnight`, async () => {
      let now = BEFORE;
      const storage = new GatedStorage(phase);
      const salt = object(storage, () => now);
      const fetching = salt.fetch();
      await storage.entered.promise;
      now = MIDNIGHT + 10;
      storage.release.resolve();
      const response = await fetching;
      const saved = storage.data.get('salt') as { day: string; salt: string };
      expect(await response.json()).toEqual(saved);
      expect(saved.day).toBe('2026-11-04');
      expect(saved.salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The previous day ends at MIDNIGHT, not one full day later. A past
      // setAlarm requests asynchronous delivery as soon as possible.
      expect(storage.alarm).toBe(MIDNIGHT);
      expect(storage.alarm).toBe(nextDayStart(BEFORE));
      await salt.alarm();
      expect(storage.data.size).toBe(0);
    });
  }

  it('keeps the same-day salt and normal deadline unchanged', async () => {
    const storage = new FakeDoStorage();
    const salt = object(storage, () => BEFORE);
    const first = await (await salt.fetch()).json();
    const second = await (await salt.fetch()).json();
    expect(first).toEqual(second);
    expect(first).toMatchObject({ day: statsDay(BEFORE) });
    expect(storage.alarm).toBe(MIDNIGHT);
    await salt.alarm();
    expect(storage.data.size).toBe(1);
    expect(storage.alarm).toBe(MIDNIGHT);
  });
});
