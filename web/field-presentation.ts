import type { ConversationField, FieldCell } from '../shared/field';

export const QUESTION_INTERVAL_MS = 2500;
export const QUESTION_READ_MS = 10000;
export const FLIP_DURATION_MS = 700;
export const CENTER_SLOT = 4;
const SIDE_SLOTS = [0, 1, 2, 3, 5, 6, 7, 8];

export type PresentedSlot = {
  cell?: FieldCell;
  previous?: FieldCell;
  shownAt: number;
  version: number;
  flipEndsAt?: number;
};
export type FieldPresentation = {
  slots: PresentedSlot[];
  targets: Array<FieldCell | undefined>;
  lastQuestionAt: number;
  reducedMotion: boolean;
};

function sameContent(a: FieldCell | undefined, b: FieldCell | undefined) {
  return a?.id === b?.id && a?.title === b?.title && a?.summary === b?.summary
    && a?.question === b?.question && a?.visited === b?.visited;
}

/** Project saved topics into fixed screen slots; world coordinates stay server-owned. */
function projectSlots(field: ConversationField, state?: FieldPresentation) {
  const focus = field.cells[field.focusId];
  const targets: Array<FieldCell | undefined> = Array(9).fill(undefined);
  if (!focus) return targets;
  targets[CENTER_SLOT] = focus;
  const others = Object.values(field.cells).filter(cell => cell.id !== focus.id);
  const distance = (cell: FieldCell) => Math.max(Math.abs(cell.x - focus.x), Math.abs(cell.y - focus.y));
  const held = new Set(state?.slots.map(slot => slot.cell?.id));
  const rank = (cell: FieldCell) => !cell.visited ? distance(cell) <= 1 ? 0 : held.has(cell.id) ? 1 : 2 : distance(cell) <= 1 ? 3 : 4;
  const candidates = others.sort((a, b) => rank(a) - rank(b) || distance(a) - distance(b) || a.y - b.y || a.x - b.x).slice(0, 8);
  const remaining = new Map(candidates.map(cell => [cell.id, cell]));
  // Keep surviving questions in their current slots, including queued replacements.
  for (const index of SIDE_SLOTS) {
    for (const id of [state?.targets[index]?.id, state?.slots[index]?.cell?.id]) {
      if (id && remaining.has(id)) { targets[index] = remaining.get(id); remaining.delete(id); break; }
    }
  }
  for (const index of SIDE_SLOTS) if (!targets[index]) {
    const cell = remaining.values().next().value as FieldCell | undefined;
    if (cell) { targets[index] = cell; remaining.delete(cell.id); }
  }
  return targets;
}

/** Restoring a saved board never replays its animation history. */
export function initialPresentation(field?: ConversationField, now = 0, reducedMotion = false): FieldPresentation {
  const targets = field ? projectSlots(field) : Array<FieldCell | undefined>(9).fill(undefined);
  return { targets, slots: targets.map(cell => ({ cell, shownAt: now, version: 0 })), lastQuestionAt: -Infinity, reducedMotion };
}

const copy = (state: FieldPresentation): FieldPresentation => ({ ...state, slots: state.slots.map(slot => ({ ...slot })) });
function begin(state: FieldPresentation, index: number, now: number) {
  const slot = state.slots[index], target = state.targets[index];
  if (sameContent(slot.cell, target)) return;
  slot.previous = state.reducedMotion || !target ? undefined : slot.cell;
  slot.cell = target;
  slot.version++;
  slot.flipEndsAt = state.reducedMotion || !target ? undefined : now + FLIP_DURATION_MS + 150;
  // The animation-end callback starts the reading window, not the model response.
  slot.shownAt = slot.flipEndsAt === undefined ? now : Infinity;
}

function changed(state: FieldPresentation, index: number) {
  return !sameContent(state.slots[index].cell, state.targets[index]);
}
function sideReadyAt(state: FieldPresentation, index: number) {
  const slot = state.slots[index];
  return slot.cell ? Math.max(slot.shownAt + QUESTION_READ_MS, state.lastQuestionAt + QUESTION_INTERVAL_MS) : -Infinity;
}

export function nextPresentationAt(state: FieldPresentation): number | undefined {
  const times: number[] = [];
  state.slots.forEach((slot, index) => {
    if (slot.flipEndsAt !== undefined) times.push(slot.flipEndsAt);
    else if (changed(state, index)) times.push(index === CENTER_SLOT ? -Infinity : sideReadyAt(state, index));
  });
  return times.length ? Math.min(...times) : undefined;
}

export function finishFlip(state: FieldPresentation, index: number, version: number, now: number): FieldPresentation {
  const slot = state.slots[index];
  if (!slot || slot.version !== version || slot.flipEndsAt === undefined) return state;
  const next = copy(state);
  next.slots[index] = { ...slot, previous: undefined, flipEndsAt: undefined, shownAt: now };
  return next;
}

export function advancePresentation(state: FieldPresentation, now: number): FieldPresentation {
  const at = nextPresentationAt(state);
  if (at === undefined || now < at) return state;
  const next = copy(state);
  // A bounded fallback also completes flips in hidden tabs or after lost CSS events.
  next.slots.forEach(slot => {
    if (slot.flipEndsAt !== undefined && now >= slot.flipEndsAt) {
      slot.previous = undefined; slot.flipEndsAt = undefined; slot.shownAt = now;
    }
  });
  if (next.slots[CENTER_SLOT].flipEndsAt === undefined && changed(next, CENTER_SLOT)) begin(next, CENTER_SLOT, now);
  // Fill genuinely empty legacy slots together, never manufacture filler content.
  for (const index of SIDE_SLOTS) if (!next.slots[index].cell && next.targets[index]) begin(next, index, now);
  const eligible = SIDE_SLOTS.filter(index => next.slots[index].flipEndsAt === undefined && changed(next, index) && now >= sideReadyAt(next, index))
    .sort((a, b) => sideReadyAt(next, a) - sideReadyAt(next, b) || a - b);
  if (eligible.length) { begin(next, eligible[0], now); next.lastQuestionAt = now; }
  return next;
}

export function reconcilePresentation(state: FieldPresentation, field: ConversationField | undefined, now: number, reducedMotion = false): FieldPresentation {
  if (!field?.cells[field.focusId]) return initialPresentation(undefined, now, reducedMotion);
  const next = copy(state);
  next.targets = projectSlots(field, state);
  next.reducedMotion = reducedMotion;
  if (reducedMotion) next.slots.forEach(slot => {
    if (slot.flipEndsAt !== undefined) { slot.previous = undefined; slot.flipEndsAt = undefined; slot.shownAt = now; }
  });
  if (state.slots.every(slot => !slot.cell)) {
    next.targets.forEach((_cell, index) => begin(next, index, now));
    next.lastQuestionAt = now;
    return next;
  }
  return advancePresentation(next, now);
}
