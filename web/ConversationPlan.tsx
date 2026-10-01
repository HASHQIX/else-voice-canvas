import type { ConversationField, PlanEntry } from '../shared/field';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { speechSpeakerLabels, type SpeechSegment } from '../shared/transcript';
import { ExportConversation } from './ExportConversation';

type PlanKind = 'clarify' | 'next' | 'settled';

function PlanItems({ items, kind }: { items: Array<string | PlanEntry>; kind: PlanKind }) {
  return <ul>{items.map((item, index) => <li key={index} title={typeof item === 'string' ? undefined : `From the conversation: “${item.sourceQuote}”`}>
    <svg className="plan-item-mark" viewBox="0 0 16 16" aria-hidden="true">
      {kind === 'settled' ? <path d="m3 8 3 3 7-7"/> : kind === 'next' ? <path d="M3 8h10M9 4l4 4-4 4"/> : <circle cx="8" cy="8" r="4"/>}
    </svg>
    <span>{typeof item === 'string' ? item : item.text}</span>
  </li>)}</ul>;
}

function PlanList({ title, items, kind }: { title: string; items: Array<string | PlanEntry>; kind: PlanKind }) {
  return <section className={`plan-section plan-${kind}`} aria-label={title}>
    <h3>{title} <span className="plan-count">{items.length}</span></h3>
    {items.length ? <PlanItems items={items} kind={kind}/> : <p className="plan-empty-note">No open questions right now.</p>}
  </section>;
}

export function ConversationPlan({ field, transcript, microphone, newConversation, projectId }: {
  field?: ConversationField; transcript: SpeechSegment[]; projectId?: string;
  microphone: { active: boolean; busy: boolean; disabled: boolean; label: string; status: string; levelRef: RefObject<HTMLSpanElement | null>; onToggle: () => void };
  newConversation: { disabled: boolean; busy: boolean; title: string; onStart: () => void };
}) {
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const contentElement = useRef<HTMLDivElement>(null);
  const transcriptElement = useRef<HTMLDivElement>(null);
  const followSpeech = useRef(true);
  useLayoutEffect(() => {
    setTranscriptOpen(true);
    setHistoryOpen(false);
    followSpeech.current = true;
    if (contentElement.current) contentElement.current.scrollTop = 0;
  }, [projectId]);
  useLayoutEffect(() => {
    if (!transcript.length) followSpeech.current = true;
    const element = transcriptElement.current;
    if (element && transcriptOpen && followSpeech.current) element.scrollTop = 0;
  }, [transcript, transcriptOpen]);
  const cells = Object.values(field?.cells || {});
  const discussed = cells.filter(cell => cell.visited);
  const plan = field?.plan;
  const focus = field?.cells[field.focusId];
  const localQuestions = cells.filter(cell => !cell.visited && (!focus || Math.abs(cell.x-focus.x)<=1 && Math.abs(cell.y-focus.y)<=1)).map(cell => cell.question);
  const questions = field?.planPending ? [...new Set([...localQuestions, ...(plan?.openQuestions || [])])].slice(0,12)
    : plan?.openQuestions ?? localQuestions;
  const speakerLabels = speechSpeakerLabels(transcript);
  return <aside id="conversation-plan" className="conversation-plan" aria-label="Conversation plan">
    <div className="plan-start">
      <button type="button" className="new-conversation" aria-label="New conversation" disabled={newConversation.disabled} aria-busy={newConversation.busy} onClick={newConversation.onStart} title={newConversation.title}>
        <span>{newConversation.busy ? 'STARTING…' : 'NEW CONVERSATION'}</span>
      </button>
      <ExportConversation projectId={projectId} disabled={newConversation.disabled || (!field && !transcript.length)}/>
    </div>
    <div id="conversation-plan-content" className="plan-body">
    <div className="plan-content" ref={contentElement} tabIndex={0} role="region" aria-label="Conversation details">
    <div className="plan-priorities">
    {field?.planPending && <p className="plan-refresh-status" role="status">Summary may lag the latest speech.</p>}
      {discussed.length ? <>
        {focus && <section className="plan-context" aria-label="Current topic"><h2>{focus.title}</h2></section>}
        <PlanList title="To clarify" items={questions} kind="clarify"/>
        {!!plan?.nextSteps.length && <PlanList title="Next steps" items={plan.nextSteps} kind="next"/>}
        {!!plan?.decisions.length && <PlanList title="Settled" items={plan.decisions} kind="settled"/>}
      </> : <div className="plan-welcome"><h2>What needs clarifying?</h2><p>Open questions, next steps and settled points will appear here.</p></div>}
    </div>
    <details className="plan-fold plan-transcript" open={transcriptOpen} onToggle={event => setTranscriptOpen(event.currentTarget.open)}>
      <summary><span>Transcript</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg></summary>
      <div className="plan-fold-content">
        <div className="transcript-scroll" ref={transcriptElement} tabIndex={0} role="region" aria-label="Conversation transcript"
          onScroll={event => { followSpeech.current = event.currentTarget.scrollTop < 24; }}>
          {transcript.length ? [...transcript].reverse().map(segment => <p key={segment.id} data-segment-id={segment.id} className={segment.final ? '' : 'transcript-interim'}>
            {speakerLabels.has(segment.id) && <span className="transcript-speaker" title="Automatic voice label. Speaker numbering is separate for each microphone session.">{speakerLabels.get(segment.id)}</span>}
            <span className="transcript-words">{segment.text}</span>
          </p>)
            : <p className="transcript-placeholder">{microphone.active ? 'Listening. Your words will appear here.' : 'Turn on the microphone to begin.'}</p>}
        </div>
      </div>
    </details>
    <details className="plan-fold plan-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
      <summary><span>History</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg></summary>
      <div className="plan-fold-content">
      {discussed.length ? <>
        <section className="plan-overview"><h2>{plan?.title || discussed[0].title}</h2><p>{plan?.summary || discussed[0].summary}</p></section>
        <section className="plan-section plan-topics"><h3>Topics discussed <span>{discussed.length}</span></h3>
          {discussed.map(cell => <article key={cell.id}><h4>{cell.title}</h4><p>{cell.summary}</p></article>)}
        </section>
      </> : <div className="plan-welcome"><h2>No history yet.</h2><p>Your summary and discussed topics will appear here.</p></div>}
      </div>
    </details>
    </div>
    </div>
    <div className="plan-footer">
    <div className="plan-microphone">
      <button type="button" className="plan-microphone-button" disabled={microphone.disabled} onClick={microphone.onToggle} aria-label={microphone.label} aria-pressed={microphone.active} aria-busy={microphone.busy} title={microphone.label}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 5l5 10H5Z"/></svg>
      </button>
      <span className="plan-microphone-status" role="status">{microphone.status}</span>
      <span className="microphone-level" data-active={microphone.active} ref={microphone.levelRef} aria-hidden="true"><i/><i/><i/><i/></span>
    </div>
    </div>
  </aside>;
}
