import { beforeEach, expect, it, vi } from 'vitest';

const publications = vi.hoisted(() => ({ plugin: vi.fn(), companion: vi.fn() }));
vi.mock('../src/market', async importOriginal => ({
  ...await importOriginal<typeof import('../src/market')>(),
  publishMarket: publications.plugin,
}));
vi.mock('../src/pet-market', async importOriginal => ({
  ...await importOriginal<typeof import('../src/pet-market')>(),
  publishPetMarket: publications.companion,
}));
import worker from '../src/index';
import { makeEnv } from './fakes';

beforeEach(() => { publications.plugin.mockReset(); publications.companion.mockReset(); });

it('waits for companion publication before reporting an independent plugin failure', async () => {
  const failure = new Error('synthetic plugin storage failure');
  const pending = Promise.withResolvers<void>();
  publications.plugin.mockRejectedValueOnce(failure);
  publications.companion.mockReturnValueOnce(pending.promise);
  const { env } = makeEnv({ PET_MARKET_ENABLED: '1' });
  const scheduled = worker.scheduled({} as ScheduledController, env);
  let settled = false;
  const observed = scheduled.then(() => { settled = true; }, () => { settled = true; });
  await vi.waitFor(() => expect(publications.companion).toHaveBeenCalledOnce());
  // Allow the rejected plugin promise to propagate through a fail-fast join.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  pending.resolve();
  await expect(scheduled).rejects.toBe(failure);
  await observed;
});

it('waits for the plugin before surfacing a sanitized companion aggregate failure', async () => {
  const failure = new Error('pet-market-publish-failed:pets=stage-budget;adapters=stored-integrity');
  const pending = Promise.withResolvers<void>();
  publications.plugin.mockReturnValueOnce(pending.promise);
  publications.companion.mockRejectedValueOnce(failure);
  const { env } = makeEnv({ PET_MARKET_ENABLED: '1' });
  const scheduled = worker.scheduled({} as ScheduledController, env);
  let settled = false;
  const observed = scheduled.then(() => { settled = true; }, () => { settled = true; });
  await vi.waitFor(() => expect(publications.plugin).toHaveBeenCalledOnce());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  pending.resolve();
  await expect(scheduled).rejects.toBe(failure);
  await observed;
});

it('rejects Cron when only the companion partitions fail', async () => {
  const failure = new Error('pet-market-publish-failed:adapters=upstream-http');
  publications.plugin.mockResolvedValueOnce(undefined);
  publications.companion.mockRejectedValueOnce(failure);
  const { env } = makeEnv({ PET_MARKET_ENABLED: '1' });
  await expect(worker.scheduled({} as ScheduledController, env)).rejects.toBe(failure);
  expect(publications.plugin).toHaveBeenCalledOnce();
  expect(publications.companion).toHaveBeenCalledOnce();
});
