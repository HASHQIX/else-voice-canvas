import { nextTopicPosition, vacantNeighbors, type ConversationField } from '../shared/field.js';

export type ContextTurn = { text: string; speaker?: string; sessionId?: string | null };
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) || []);

/** One bounded speech window, not parallel copies of source and speaker history. */
export function recentTurns(turns: ContextTurn[], maxChars = 2400) {
  const result: ContextTurn[] = [];
  for (const turn of turns.slice(-6).reverse()) {
    if (turn.text.length > maxChars) break; // Never truncate away a negation or attribution.
    result.unshift(turn);
    maxChars -= turn.text.length;
  }
  return result;
}

export function fastContext(field: ConversationField | undefined, text: string, turns: ContextTurn[]) {
  const all = Object.values(field?.cells || {}), focus = all.find(cell => cell.id === field?.focusId);
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
  const tokens = words(text);
  const score = (cell: typeof all[number]) => [...words(`${cell.title} ${cell.summary} ${cell.question}`)].filter(word => tokens.has(word)).length;
  const local = focus ? all.filter(cell => near(cell, focus)) : [];
  const recalled = all.filter(cell => !local.includes(cell) && score(cell) > 0)
    .sort((a, b) => score(b) - score(a)).slice(0, 3);
  const newCenter = nextTopicPosition(field);
  const describe = (cell: typeof all[number]) => ({ id: cell.id, title: cell.title, summary: cell.summary, question: cell.question, visited: cell.visited,
    vacancies: vacantNeighbors(field, cell).length,
    unvisitedNeighborIds: all.filter(other => other.id !== cell.id && !other.visited && near(cell, other)).map(other => other.id),
    neighborTitles: all.filter(other => other.id !== cell.id && near(cell, other)).map(other => other.title) });
  return {
    text, speakerTurns: recentTurns(turns),
    memory: field?.plan ? { title: field.plan.title, summary: field.plan.summary.slice(0, 800),
      decisions: field.plan.decisions.slice(0, 6).map(entry => entry.text),
      openQuestions: field.plan.openQuestions.slice(0, 4) } : null,
    conversationField: { isInitial: !field, focusId: field?.focusId ?? null, cells: [...local, ...recalled].map(describe),
      newTopicVacancies: vacantNeighbors(field, newCenter).length,
      newTopicUnvisitedNeighborIds: all.filter(cell => !cell.visited && near(cell, newCenter)).map(cell => cell.id),
      newTopicNeighborTitles: all.filter(cell => near(cell, newCenter)).map(cell => cell.title) },
  };
}
