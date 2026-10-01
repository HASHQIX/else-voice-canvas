import { expect, it } from 'vitest';
import type { ConversationField, FieldCell } from '../shared/field';
import { advancePresentation, finishFlip, initialPresentation, nextPresentationAt, reconcilePresentation, type FieldPresentation } from '../web/field-presentation';

const question = (id: string, x: number, y: number): FieldCell => ({ id, x, y, title: id, summary: '', question: 'What about ' + id + '?', visited: false });
function field(): ConversationField {
  const cells: Record<string, FieldCell> = { topic: { ...question('topic', 0, 0), summary: 'Planning a shoot.', visited: true } };
  const positions = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
  ['models','studio','budget','rights','dates','crew','style','backup'].forEach((id,index) => { cells[id] = question(id, ...positions[index] as [number,number]); });
  return { focusId: 'topic', cells };
}
const settled = (state: FieldPresentation, now: number) => state.slots.reduce((current, slot, index) => finishFlip(current, index, slot.version, now), state);
const slotOf = (state: FieldPresentation, id: string) => state.slots.findIndex(slot => slot.cell?.id === id);

it('fills all nine fixed slots together and starts reading time only after the flip finishes', () => {
  const original = field(), empty = initialPresentation();
  const opening = reconcilePresentation(empty, original, 100);
  expect(opening.slots.filter(slot => slot.cell)).toHaveLength(9);
  expect(opening.slots.every(slot => slot.flipEndsAt === 950 && slot.shownAt === Infinity)).toBe(true);
  const ready = settled(opening, 825);
  expect(ready.slots.every(slot => slot.shownAt === 825 && slot.flipEndsAt === undefined)).toBe(true);
  expect(ready.slots[4].cell?.id).toBe('topic');
  expect(nextPresentationAt(ready)).toBeUndefined();
  expect(empty.slots.every(slot => !slot.cell)).toBe(true);
});

it('keeps nine occupied positions when a distant new topic has only a few new neighbors', () => {
  const original = field(), before = structuredClone(original);
  const display = initialPresentation(original, 0);
  const moved = structuredClone(original);
  moved.cells.travel = { ...question('travel', 20, 20), summary: 'Planning a trip.', visited: true };
  moved.cells.visa = question('visa', 19, 19);
  moved.cells.route = question('route', 20, 19);
  moved.focusId = 'travel';
  let state = reconcilePresentation(display, moved, 1000);
  expect(state.slots[4].cell?.id).toBe('travel');
  expect(state.slots[4].previous?.id).toBe('topic');
  expect(state.slots.filter(slot => slot.cell)).toHaveLength(9);
  for (let index=0; index<9; index++) if(index!==4) expect(state.slots[index].cell).toBe(display.slots[index].cell);
  state = settled(state, 1700);
  for (const now of [10000,10850,12500,13350,15000,15850]) {
    state = advancePresentation(state, now);
    expect(state.slots.filter(slot => slot.cell)).toHaveLength(9);
  }
  expect(state.slots.some(slot => slot.cell?.id === 'visa')).toBe(true);
  expect(state.slots.some(slot => slot.cell?.id === 'route')).toBe(true);
  expect(original).toEqual(before);
  expect(Object.keys(moved.cells)).toHaveLength(12);
});

it('holds each completed side face for ten seconds and coalesces to the newest pending text', () => {
  const original = field(), display = initialPresentation(original, 0), index = slotOf(display, 'models');
  const friday = structuredClone(original); friday.cells.models.question = 'Are models available Friday?';
  let state = reconcilePresentation(display, friday, 100);
  const saturday = structuredClone(friday); saturday.cells.models.question = 'Are models available Saturday?';
  state = reconcilePresentation(state, saturday, 5000);
  expect(nextPresentationAt(state)).toBe(10000);
  expect(advancePresentation(state, 9999)).toBe(state);
  state = advancePresentation(state, 10000);
  expect(state.slots[index].previous?.question).toBe('What about models?');
  expect(state.slots[index].cell?.question).toBe(saturday.cells.models.question);
  const sunday = structuredClone(saturday); sunday.cells.models.question = 'Are models available Sunday?';
  state = reconcilePresentation(state, sunday, 10100);
  expect(state.slots[index].cell?.question).toBe(saturday.cells.models.question);
  state = finishFlip(state, index, state.slots[index].version, 10780);
  expect(nextPresentationAt(state)).toBe(20780);
  expect(advancePresentation(state, 20779)).toBe(state);
  expect(advancePresentation(state, 20780).slots[index].cell?.question).toBe(sunday.cells.models.question);
});

it('staggers eligible different side slots by 2.5 seconds without shortening their individual reading windows', () => {
  const original = field(), display = initialPresentation(original, 0);
  const updated = structuredClone(original);
  for (const id of ['models','studio','budget']) updated.cells[id].question = 'Latest question about ' + id + '?';
  let state = reconcilePresentation(display, updated, 100);
  state = advancePresentation(state, 10000);
  expect(state.slots.filter(slot => slot.previous)).toHaveLength(1);
  state = settled(state, 10700);
  expect(nextPresentationAt(state)).toBe(12500);
  state = advancePresentation(state, 12500);
  state = settled(state, 13200);
  expect(nextPresentationAt(state)).toBe(15000);
  state = settled(advancePresentation(state, 15000), 15700);
  expect(nextPresentationAt(state)).toBeUndefined();
  expect(['models','studio','budget'].map(id => state.slots[slotOf(state,id)].shownAt)).toEqual([10700,13200,15700]);
});

it('changes the center in place and lets an in-flight flip finish before using the latest focus', () => {
  const original = field(), display = initialPresentation(original, 0);
  const models = structuredClone(original); models.focusId = 'models'; models.cells.models.visited = true;
  let state = reconcilePresentation(display, models, 100);
  const studio = structuredClone(models); studio.focusId = 'studio'; studio.cells.studio.visited = true;
  state = reconcilePresentation(state, studio, 200);
  expect(state.slots[4].cell?.id).toBe('models');
  state = finishFlip(state, 4, state.slots[4].version, 800);
  state = advancePresentation(state, 800);
  expect(state.slots[4].cell?.id).toBe('studio');
  expect(state.slots[4].previous?.id).toBe('models');
  expect(state.slots.filter(slot=>slot.cell)).toHaveLength(9);
});

it('cancels retracted replacements and ignores identical recap snapshots', () => {
  const original = field(), display = initialPresentation(original, 0);
  const proposed = structuredClone(original); proposed.cells.models.question = 'A temporary suggestion?';
  const pending = reconcilePresentation(display, proposed, 100);
  const reverted = reconcilePresentation(pending, original, 200);
  expect(nextPresentationAt(reverted)).toBeUndefined();
  expect(reverted.slots.every(slot => slot.version === 0)).toBe(true);
  const recap = reconcilePresentation(reverted, { ...original, planPending: true }, 300);
  expect(recap.slots).toEqual(reverted.slots);
});

it('restores without flips and honors the ten-second hold with reduced motion too', () => {
  const original = field(), restored = initialPresentation(original, 100, true);
  expect(restored.slots.every(slot => slot.flipEndsAt === undefined)).toBe(true);
  const update = structuredClone(original); update.cells.models.question = 'A newer question?';
  let state = reconcilePresentation(restored, update, 200, true);
  expect(nextPresentationAt(state)).toBe(10100);
  state = advancePresentation(state, 10100);
  expect(state.slots[slotOf(state,'models')].cell?.question).toBe('A newer question?');
  expect(state.slots.every(slot => slot.flipEndsAt === undefined)).toBe(true);
});

it('finishes lost animation events conservatively and discards all pending work on reset', () => {
  const original = field();
  const opening = reconcilePresentation(initialPresentation(), original, 0);
  const overdue = advancePresentation(opening, 1500);
  expect(overdue.slots.every(slot=>slot.shownAt===1500)).toBe(true);
  expect(finishFlip(overdue,0,999,1600)).toBe(overdue);
  const changed = structuredClone(original); changed.cells.models.question='Queued?';
  const queued = reconcilePresentation(overdue,changed,1600);
  const reset = reconcilePresentation(queued,undefined,1700);
  expect(reset.slots.every(slot=>!slot.cell)).toBe(true);
  expect(nextPresentationAt(reset)).toBeUndefined();
});

it('does not fabricate cards when an older saved field has fewer than nine topics', () => {
  const original = field();
  const legacy = { ...original, cells: { topic: original.cells.topic, models: original.cells.models } };
  const state = initialPresentation(legacy,0);
  expect(state.slots.filter(slot=>slot.cell)).toHaveLength(2);
  expect(state.slots[4].cell?.id).toBe('topic');
});
