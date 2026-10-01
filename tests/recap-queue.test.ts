import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyField } from '../server/field.js';
const provider = vi.hoisted(() => vi.fn());
vi.mock('../server/providers.js', () => ({ structuredResponse: provider }));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'else-recap-test-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
let store: typeof import('../server/db.js'), Queue: typeof import('../server/recap-queue.js').RecapQueue;
let queue: InstanceType<typeof Queue>;
const owner = 'recap-owner';
const plan = { title: 'Shoot', summary: 'Planning a shoot.', decisions: [], nextSteps: [], openQuestions: ['When is it?'] };
beforeAll(async () => { store = await import('../server/db.js'); Queue = (await import('../server/recap-queue.js')).RecapQueue; store.ensureOwner(owner); });
afterEach(() => { queue?.close(); vi.useRealTimers(); provider.mockReset(); });
afterAll(() => { store.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
function fixture(count = 1) {
  const project = store.createProject(owner, 'Recap test'), branch = project.branches[0].id;
  const text = 'We are planning a shoot.';
  const ids = Array.from({ length: count }, (_, i) => store.saveTranscript(owner, project.id, branch, `${text} Detail ${i}.`));
  const snapshot = project.branches[0].snapshot;
  snapshot.field = { ...applyField(undefined, { targetId: null, title: 'Shoot', summary: text, sourceQuote: text, neighbors: [] }, ids[0]), planPending: true, planPendingTurnIds: ids };
  store.saveBranch(owner, project.id, branch, snapshot, 'final_plan', { turnId: ids[0] }, 0);
  const notify = vi.fn();
  return { project: project.id, branch, owner, clientId: 'recap-client', notify, ids, text };
}
const saved = (job: ReturnType<typeof fixture>) => store.getBranch(owner, job.project, job.branch)!;
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

it('coalesces turns, persists a recap without adding an undo step, and carries old quote evidence', async () => {
  vi.useFakeTimers(); const job = fixture(2);
  const oldPlan = { ...plan, decisions: [{ text: 'Friday confirmed.', sourceQuote: 'Friday confirmed' }] };
  const current = saved(job); current.snapshot.field!.plan = oldPlan;
  store.saveRecap(owner, job.project, job.branch, current.snapshot, current.revision);
  store.saveTranscript(owner, job.project, job.branch, 'Failed inference must stay out of recap.');
  provider.mockResolvedValue({ plan: oldPlan });
  queue = new Queue(() => false, 20, 60);
  queue.schedule(job); await vi.advanceTimersByTimeAsync(10); queue.schedule(job);
  await vi.advanceTimersByTimeAsync(19); expect(provider).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(provider.mock.calls[0][1].turns.map((turn: any) => turn.id)).toEqual(job.ids);
  expect(saved(job).snapshot.field).toMatchObject({ plan: oldPlan, planPending: false, planPendingTurnIds: [] });
  expect(job.notify).toHaveBeenCalledWith('fork.plan', expect.anything());
  const undone = store.historyStep(owner, job.project, job.branch, saved(job).revision, -1);
  expect(undone.field).toBeUndefined();
});

it('aborts a stale recap and retries the newest scheduled work even when a provider ignores abort', async () => {
  vi.useFakeTimers(); const job = fixture(), first = deferred();
  provider.mockReturnValueOnce(first.promise).mockResolvedValue({ plan });
  queue = new Queue(() => false, 20, 60); queue.schedule(job);
  await vi.advanceTimersByTimeAsync(20);
  queue.hold(`${job.project}:${job.branch}`);
  expect(provider.mock.calls[0][2].aborted).toBe(true);
  const latest = saved(job); latest.snapshot.field!.cells[latest.snapshot.field!.focusId].summary = 'A new direction.';
  store.saveBranch(owner, job.project, job.branch, latest.snapshot, 'final_plan', {}, latest.revision);
  queue.resume(`${job.project}:${job.branch}`); queue.schedule(job);
  first.resolve({ plan: { ...plan, summary: 'Stale summary.' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(saved(job).snapshot.field!.plan).toBeUndefined();
  await vi.advanceTimersByTimeAsync(20);
  expect(provider).toHaveBeenCalledTimes(2);
  expect(saved(job).snapshot.field!.plan?.summary).toBe(plan.summary);
  expect(saved(job).snapshot.field!.cells[latest.snapshot.field!.focusId].summary).toBe('A new direction.');
});

it('rechecks the revision before saving a recap and batches pending turns without losing them', async () => {
  vi.useFakeTimers(); const job = fixture(14), first = deferred();
  provider.mockReturnValueOnce(first.promise).mockResolvedValue({ plan });
  queue = new Queue(() => false, 20, 60); queue.schedule(job); await vi.advanceTimersByTimeAsync(20);
  const current = saved(job); store.saveBranch(owner, job.project, job.branch, current.snapshot, 'final_plan', {}, current.revision);
  first.resolve({ plan }); await vi.advanceTimersByTimeAsync(0);
  expect(saved(job).snapshot.field!.plan).toBeUndefined();
  await vi.advanceTimersByTimeAsync(40);
  expect(provider).toHaveBeenCalledTimes(3);
  expect(provider.mock.calls[1][1].turns).toHaveLength(12);
  expect(provider.mock.calls[2][1].turns.map((turn: any) => turn.id)).toEqual(job.ids.slice(12));
  expect(saved(job).snapshot.field!.planPending).toBe(false);
});

it('cancels project jobs on reset and blocks writes after lease takeover', async () => {
  vi.useFakeTimers(); const job = fixture(), first = deferred();
  provider.mockReturnValueOnce(first.promise);
  queue = new Queue(() => false, 20, 60); queue.schedule(job); await vi.advanceTimersByTimeAsync(20);
  queue.cancelProject(job.project); first.resolve({ plan }); await vi.advanceTimersByTimeAsync(100);
  expect(saved(job).revision).toBe(1); expect(job.notify).not.toHaveBeenCalled();
  provider.mockResolvedValue({ plan }); store.acquireLease(job.project, 'another-tab', true);
  queue.schedule(job); await vi.advanceTimersByTimeAsync(20);
  expect(provider).toHaveBeenCalledTimes(1); expect(saved(job).revision).toBe(1);
});

it('preserves the saved field on provider failure without an automatic paid retry loop', async () => {
  vi.useFakeTimers(); const job = fixture(); provider.mockRejectedValue(new Error('Unavailable'));
  queue = new Queue(() => false, 20, 60); queue.schedule(job); await vi.advanceTimersByTimeAsync(1000);
  expect(provider).toHaveBeenCalledTimes(1); expect(saved(job).snapshot.field!.planPending).toBe(true);
  expect(job.notify).toHaveBeenCalledWith('fork.plan_status', { status: 'deferred' });
});

it('limits recaps to two concurrent calls and waits while fast inference is busy', async () => {
  vi.useFakeTimers(); const jobs = [fixture(), fixture(), fixture()], response = deferred(); let busy = true;
  provider.mockReturnValue(response.promise);
  queue = new Queue(() => busy, 20, 60); jobs.forEach(job => queue.schedule(job));
  await vi.advanceTimersByTimeAsync(40); expect(provider).not.toHaveBeenCalled();
  busy = false; await vi.advanceTimersByTimeAsync(20); expect(provider).toHaveBeenCalledTimes(2);
  response.resolve({ plan }); await vi.advanceTimersByTimeAsync(20); expect(provider).toHaveBeenCalledTimes(3);
  expect(jobs.every(job => !saved(job).snapshot.field!.planPending)).toBe(true);
});
