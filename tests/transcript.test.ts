import { expect, it } from 'vitest';
import { mergeSpeechSegments, normalizeSpeaker, speechSpeakerLabels, type SpeechSegment } from '../shared/transcript.js';

const first:SpeechSegment={id:'session-1:0',text:'We need two',final:false,createdAt:'2026-09-30T10:00:00.000Z'};
it('replaces partial speech with its final text without adding duplicate paragraphs',()=>{
 const complete={...first,text:'We need two models for Friday.',final:true};
 expect(mergeSpeechSegments([first],[complete])).toEqual([complete]);
 expect(first.text).toBe('We need two');
});
it('keeps separate utterances and sessions even when the spoken words repeat',()=>{
 const next={...first,id:'session-2:0',createdAt:'2026-09-30T10:01:00.000Z'};
 expect(mergeSpeechSegments([first],[next])).toEqual([first,next]);
});
it('merges loaded history with newer live speech without truncating the words',()=>{
 const live={...first,text:'Full recognized speech. '.repeat(40),final:true};
 const earlier={...first,id:'earlier:0',createdAt:'2026-09-30T09:00:00.000Z'};
 expect(mergeSpeechSegments([earlier,first],[live])).toEqual([earlier,live]);
});
it('keeps speaker corrections on the existing utterance and displays unknown without guessing',()=>{
 const partial={...first,speaker:'UNKNOWN',sessionId:'session-1'};
 const complete={...partial,speaker:'B',final:true};
 expect(speechSpeakerLabels([partial]).get(first.id)).toBe('Unknown');
 expect(speechSpeakerLabels(mergeSpeechSegments([partial],[complete])).get(first.id)).toBe('Person 2');
 expect(normalizeSpeaker(null)).toBe('UNKNOWN');
 expect(normalizeSpeaker('untrusted label')).toBe('UNKNOWN');
 expect(speechSpeakerLabels([first]).size).toBe(0);
});
it('does not equate voices from separate microphone sessions or renumber them in reverse display order',()=>{
 const a={...first,speaker:'A',sessionId:'session-1'};
 const b={...first,id:'session-2:0',createdAt:'2026-09-30T10:01:00Z',speaker:'A',sessionId:'session-2'};
 const labels=speechSpeakerLabels([b,a]);
 expect(labels.get(a.id)).toBe('Person 1 · Session 1');
 expect(labels.get(b.id)).toBe('Person 1 · Session 2');
});
