import * as store from './db.js';
import { structuredResponse } from './providers.js';
import { recapProposal } from './fast-schema.js';
import type { ConversationField } from '../shared/field.js';
import { speakerName } from '../shared/transcript.js';

type Job = { owner: string; project: string; branch: string; clientId?: string;
  notify: (type: string, payload: unknown) => void };
type Pending = { job: Job; since: number; timer?: ReturnType<typeof setTimeout>; controller?: AbortController; held: boolean; generation: number };

/** Coalesced, bounded memory work. Fast field updates always take precedence. */
export class RecapQueue {
  private jobs = new Map<string, Pending>();
  private closed = false;
  private running = 0;
  constructor(private busy: (key: string) => boolean, private delay = 4000, private maxWait = 12000) {}
  private key(job: Job) { return `${job.project}:${job.branch}`; }
  schedule(job: Job) {
    if (this.closed) return;
    const key = this.key(job), pending = this.jobs.get(key) || { job, since: Date.now(), held: false, generation: 0 };
    pending.job = job;
    pending.generation++;
    this.jobs.set(key, pending);
    this.arm(key, pending);
  }
  private arm(key: string, pending: Pending) {
    clearTimeout(pending.timer);
    if (this.closed || pending.held || pending.controller) return;
    pending.timer = setTimeout(() => void this.run(key, pending), Math.max(0, Math.min(this.delay, this.maxWait - (Date.now() - pending.since))));
    pending.timer.unref();
  }
  hold(key: string) {
    const pending = this.jobs.get(key);
    if (!pending) return;
    pending.held = true;
    clearTimeout(pending.timer);
    pending.controller?.abort();
  }
  resume(key: string) {
    const pending = this.jobs.get(key);
    if (!pending) return;
    pending.held = false;
    this.arm(key, pending);
  }
  cancelProject(project: string) {
    for (const [key, pending] of this.jobs) if (pending.job.project === project) {
      clearTimeout(pending.timer); pending.controller?.abort(); this.jobs.delete(key);
    }
  }
  close() {
    this.closed = true;
    for (const pending of this.jobs.values()) { clearTimeout(pending.timer); pending.controller?.abort(); }
    this.jobs.clear();
  }
  private async run(key: string, pending: Pending) {
    if (this.closed || pending.held || this.jobs.get(key) !== pending) return;
    if (this.busy(key) || this.running >= 2) {
      pending.timer = setTimeout(() => void this.run(key, pending), this.delay);
      pending.timer.unref(); return;
    }
    const job = pending.job, generation = pending.generation;
    const branch = store.getBranch(job.owner, job.project, job.branch);
    if (!branch?.snapshot.field?.planPending) { this.jobs.delete(key); return; }
    const controller = new AbortController(); pending.controller = controller; this.running++;
    let retry = false;
    try {
      store.assertLease(job.project, job.clientId);
      const field = branch.snapshot.field as ConversationField;
      // Only committed turns belonging to this snapshot are eligible. Failed
      // inference transcripts and undone future turns must never reappear.
      const turns: Array<{ id: string; text: string; speakerTurns: unknown[] }> = []; let chars = 0;
      for (const id of field.planPendingTurnIds || []) {
        const row = store.db.prepare('SELECT id,text FROM transcripts WHERE id=? AND owner_id=? AND project_id=?')
          .get(id, job.owner, job.project) as { id: string; text: string } | undefined;
        if (!row) continue;
        if (turns.length && (chars + row.text.length > 8000 || turns.length >= 12)) break;
        const event = store.db.prepare("SELECT payload FROM events WHERE owner_id=? AND project_id=? AND type='final_plan' AND json_extract(payload,'$.turnId')=? ORDER BY rowid DESC LIMIT 1")
          .get(job.owner, job.project, id) as { payload: string } | undefined;
        const throughId = event && JSON.parse(event.payload).throughSpeechId;
        const speech = throughId ? store.speechContextFor(job.owner, job.project, throughId) : [];
        let remaining = row.text.length;
        const speakerTurns = [];
        for (const segment of speech.reverse()) {
          if (segment.text.length > remaining || !row.text.includes(segment.text)) break;
          speakerTurns.unshift({ text: segment.text, speaker: segment.speaker === undefined ? 'Unknown' : speakerName(segment.speaker), sessionId: segment.sessionId || null });
          remaining -= segment.text.length + 1;
        }
        turns.push({ ...row, speakerTurns }); chars += row.text.length;
      }
      if (!turns.length) { this.jobs.delete(key); return; }
      const ids = new Set(turns.map(turn => turn.id));
      const topics = Object.values(field.cells).filter(cell => cell.sourceRef && ids.has(cell.sourceRef.turnId))
        .slice(-6).map(cell => ({ title: cell.title, summary: cell.summary }));
      const input = { previousPlan: field.plan || null, turns, topics };
      const result = await structuredResponse('recap', input, controller.signal);
      const plan = recapProposal(result, [...turns.map(turn => turn.text),
        ...(field.plan?.decisions || []).map(entry => entry.sourceQuote), ...(field.plan?.nextSteps || []).map(entry => entry.sourceQuote)]);
      if (controller.signal.aborted || this.closed || this.jobs.get(key) !== pending) { retry = controller.signal.aborted; return; }
      const saved = store.db.transaction(() => {
        store.assertLease(job.project, job.clientId);
        const current = store.getBranch(job.owner, job.project, job.branch);
        if (!current) return null;
        // Never apply an old plan over a newer thought, manual edit or undo.
        if (this.busy(key) || current.revision !== branch.revision) { retry = true; return null; }
        const next = structuredClone(current.snapshot);
        next.field!.plan = plan;
        next.field!.planPendingTurnIds = (field.planPendingTurnIds || []).filter(id => !ids.has(id));
        next.field!.planPending = next.field!.planPendingTurnIds.length > 0;
        return store.saveRecap(job.owner, job.project, job.branch, next, current.revision);
      })();
      if (saved) { job.notify('fork.plan', { snapshot: saved }); retry = Boolean(saved.field?.planPending); }
    } catch {
      // A recap failure never rolls back the fast field or interrupts transcription.
      if (!controller.signal.aborted) job.notify('fork.plan_status', { status: 'deferred' });
      retry = controller.signal.aborted;
    } finally {
      this.running--; pending.controller = undefined;
      if (this.jobs.get(key) === pending) {
        if (pending.held || retry || pending.generation !== generation) { pending.since = Date.now(); this.arm(key, pending); }
        else this.jobs.delete(key);
      }
    }
  }
}
