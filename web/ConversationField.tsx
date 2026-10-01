import type { ConversationField as Field } from '../shared/field';
import { useFieldPresentation } from './useFieldPresentation';
import { CENTER_SLOT, FLIP_DURATION_MS } from './field-presentation';
import { ConversationInvitation } from './ConversationInvitation';

const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
function topicCaption(text: string) {
  return Array.from(sentences.segment(text.trim()))[0]?.segment.trim() || '';
}

export function ConversationField({ field, transcript, preview, thinking, paused, microphone }: {
  field?: Field; transcript: string; preview: string; thinking: boolean; paused: boolean;
  microphone: { disabled: boolean; status: string; onStart: () => void };
}) {
  const { presentation, completeFlip } = useFieldPresentation(field);
  const focus = presentation.slots[CENTER_SLOT].cell;
  return <div className="field-viewport" aria-label="Conversation field">
    <div className="field-grid-viewport" aria-hidden="true"><div className="field-world-grid"/></div>
    <div className="field-content-viewport">
      {!field ? <div className="empty-grid">
        {Array.from({ length: 9 }, (_, index) => index === CENTER_SLOT ? <section key={index} className="empty-center">
          {preview && <h1>{preview}</h1>}
          {transcript && <p>{topicCaption(transcript)}</p>}
          {(!(preview || transcript) || paused) && <ConversationInvitation
            caption={paused ? 'Tap to begin a conversation' : thinking ? 'Finding your next question' : microphone.status === 'Microphone on' ? 'Listening. Speak your mind.' : microphone.status}
            disabled={microphone.disabled} onStart={paused ? microphone.onStart : undefined}
          />}
        </section> : <div className="empty-cell" key={index}/>)}
      </div> : <div className="field-board">
        {presentation.slots.map((slot, index) => {
          const cell = slot.cell, current = index === CENTER_SLOT, turning = slot.flipEndsAt !== undefined;
          return <section key={index} className={'field-cell' + (current ? ' current' : '') + (cell?.visited ? ' visited' : '')}
            data-slot={index} data-cell-id={cell?.id} data-world-x={cell?.x} data-world-y={cell?.y}
            data-visible="true" data-flipping={turning} data-version={slot.version}
            data-readable-since={Number.isFinite(slot.shownAt) ? slot.shownAt : undefined}
            aria-label={cell ? (current ? 'Current topic: ' : cell.visited ? 'Explored topic: ' : 'Blind spot: ') + cell.title : 'Waiting for a question'}>
            <div key={slot.version} className="card-turn" data-turning={turning} style={{ animationDuration: FLIP_DURATION_MS + 'ms' }}
              onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName === 'card-flip') completeFlip(index, slot.version); }}>
              {turning && <div className="card-face card-front" aria-hidden="true">
                {slot.previous && <div className="cell-copy"><div className="focus-title">{slot.previous.title}</div><div className="focus-caption">{topicCaption(slot.previous.visited ? slot.previous.summary : slot.previous.question)}</div></div>}
              </div>}
              <div className={'card-face ' + (turning ? 'card-back' : 'card-front')}>
                {cell && <div className="cell-copy"><h2>{cell.title}</h2><p>{topicCaption(cell.visited ? cell.summary : cell.question)}</p></div>}
              </div>
            </div>
          </section>;
        })}
      </div>}
    </div>
    <span className="sr-only" role="status">{focus ? 'Current topic: ' + focus.title : 'Waiting for a conversation'}</span>
  </div>;
}
