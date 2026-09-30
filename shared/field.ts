/** Persistent world coordinates. Moving focus moves the camera, never the cells. */
export interface FieldCell {
  id: string;
  x: number;
  y: number;
  title: string;
  question: string;
  summary: string;
  visited: boolean;
  sourceRef?: { turnId: string; quote: string };
}

export interface PlanEntry {
  text: string;
  sourceQuote: string;
}

export interface ConversationPlan {
  title: string;
  summary: string;
  decisions: PlanEntry[];
  nextSteps: PlanEntry[];
  openQuestions: string[];
}

export interface ConversationField {
  focusId: string;
  cells: Record<string, FieldCell>;
  plan?: ConversationPlan;
}

export interface FieldProposal {
  targetId: string | null;
  title: string;
  summary: string;
  sourceQuote: string;
  neighbors: Array<{ title: string; question: string }>;
  updates?: Array<{ targetId: string; summary: string; sourceQuote: string }>;
  plan?: ConversationPlan;
}

export const neighborOffsets = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],            [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
] as const;

export function cellAt(field: ConversationField, x: number, y: number) {
  return Object.values(field.cells).find(cell => cell.x === x && cell.y === y);
}

export function nextTopicPosition(field?: ConversationField): { x: number; y: number } {
  if (!field) return { x: 0, y: 0 };
  const focus = field.cells[field.focusId];
  for (let radius = 1; ; radius++) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== radius) continue;
        if (!cellAt(field, focus.x + x, focus.y + y)) return { x: focus.x + x, y: focus.y + y };
      }
    }
  }
}

export function vacantNeighbors(field: ConversationField | undefined, center: { x: number; y: number }) {
  return neighborOffsets.map(([dx, dy]) => ({ x: center.x + dx, y: center.y + dy }))
    .filter(({ x, y }) => !field || !cellAt(field, x, y));
}

/** Compact model context includes the exact number of questions needed at each destination. */
export function fieldContext(field?: ConversationField) {
  const newCenter = nextTopicPosition(field);
  return {
    focusId: field?.focusId ?? null,
    plan: field?.plan ?? null,
    newTopicVacancies: vacantNeighbors(field, newCenter).length,
    newTopicNeighborIds: field ? Object.values(field.cells).filter(cell => {
      return Math.abs(cell.x - newCenter.x) <= 1 && Math.abs(cell.y - newCenter.y) <= 1;
    }).map(cell => cell.id) : [],
    cells: field ? Object.values(field.cells).map(cell => ({
      id: cell.id, title: cell.title, question: cell.question, summary: cell.summary,
      visited: cell.visited, vacancies: vacantNeighbors(field, cell).length,
      neighborIds: Object.values(field.cells).filter(other => other.id !== cell.id && Math.abs(other.x - cell.x) <= 1 && Math.abs(other.y - cell.y) <= 1).map(other => other.id),
    })) : [],
  };
}
