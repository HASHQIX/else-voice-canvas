import type { ConversationField } from './field.js';
import { mergeSpeechSegments, speechSpeakerLabels, type SpeechSegment } from './transcript.js';

export interface ConversationReport {
  title: string;
  capturedAt: string;
  inProgress: boolean;
  decisions: string[];
  openQuestions: string[];
  nextSteps: string[];
  summary: string;
  topics: Array<{ title: string; summary: string }>;
  transcript: SpeechSegment[];
}

export function buildConversationReport(field: ConversationField | undefined, transcript: SpeechSegment[], capturedAt: string, inProgress = false): ConversationReport {
  const cells = Object.values(field?.cells || {});
  const topics = cells.filter(cell => cell.visited).map(({ title, summary }) => ({ title, summary }));
  return {
    title: field?.plan?.title || topics[0]?.title || 'Conversation report',
    capturedAt,
    inProgress,
    decisions: field?.plan?.decisions.map(entry => entry.text) || [],
    openQuestions: [...(field?.plan?.openQuestions ?? cells.filter(cell => !cell.visited).map(cell => cell.question))],
    nextSteps: field?.plan?.nextSteps.map(entry => entry.text) || [],
    summary: field?.plan?.summary || '',
    topics,
    transcript: mergeSpeechSegments([], transcript).map(segment => ({ ...segment })),
  };
}

export function reportToText(report: ConversationReport) {
  const speakerLabels = speechSpeakerLabels(report.transcript);
  const list = (items: string[], empty: string) => items.length ? items.map((item, i) => `${i + 1}. ${item}`).join('\n') : empty;
  return [
    report.title,
    `ELSE · Conversation report · ${report.capturedAt}`,
    ...(report.inProgress ? ['Exported during an ongoing conversation. The latest speech may still be awaiting analysis.'] : []),
    'SETTLED — PRIORITY ORDER', list(report.decisions, 'No confirmed decisions or facts recorded.'),
    'STILL OPEN — PRIORITY ORDER', list(report.openQuestions, 'No open questions recorded.'),
    'NEXT STEPS — PRIORITY ORDER', list(report.nextSteps, 'No next steps recorded.'),
    'SUMMARY', report.summary || 'No summary recorded yet.',
    'TOPICS DISCUSSED', report.topics.length ? report.topics.map(topic => `${topic.title}\n${topic.summary}`).join('\n\n') : 'No topics recorded yet.',
    'FULL TRANSCRIPT — OLDEST FIRST', report.transcript.length ? report.transcript.map(segment => `${speakerLabels.has(segment.id) ? `${speakerLabels.get(segment.id)}\n` : ''}${segment.text}${segment.final ? '' : '\n[Unfinished speech]'}`).join('\n\n') : 'No transcript recorded.',
  ].join('\n\n');
}
