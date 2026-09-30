export type SpeechSegment = { id: string; text: string; final: boolean; createdAt: string; speaker?: string; sessionId?: string };

/** Provider labels identify voices within one streaming session, not across reconnects. */
export function normalizeSpeaker(label: unknown): string {
  return typeof label === 'string' && /^[A-Z]$/.test(label) ? label : 'UNKNOWN';
}

export function speakerName(label: string): string {
  return normalizeSpeaker(label) === 'UNKNOWN' ? 'Unknown' : `Person ${label.charCodeAt(0) - 64}`;
}

export function speechSpeakerLabels(segments: SpeechSegment[]): Map<string, string> {
  const ordered = mergeSpeechSegments([], segments);
  const sessions = [...new Set(ordered.filter(segment => segment.speaker !== undefined && segment.sessionId).map(segment => segment.sessionId!))];
  return new Map(ordered.filter(segment => segment.speaker !== undefined).map(segment => [segment.id,
    speakerName(segment.speaker!) + (sessions.length > 1 && segment.sessionId ? ` · Session ${sessions.indexOf(segment.sessionId) + 1}` : ''),
  ]));
}

/** ASR corrections replace their segment; separate utterances remain distinct. */
export function mergeSpeechSegments(previous: SpeechSegment[], incoming: SpeechSegment[]): SpeechSegment[] {
  const segments = new Map(previous.map(segment => [segment.id, segment]));
  for (const segment of incoming) segments.set(segment.id, segment);
  return [...segments.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
