import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ConversationField as Field } from '../shared/field';

const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

function topicCaption(text: string) {
  // Older conversations retain their full summaries in the plan sidebar.
  return Array.from(sentences.segment(text.trim()))[0]?.segment.trim() || '';
}

export function ConversationField({ field, transcript, preview, thinking, paused, microphone }: {
  field?: Field; transcript: string; preview: string; thinking: boolean; paused: boolean;
  microphone: { disabled: boolean; onStart: () => void };
}) {
  const cameraElement = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = cameraElement.current!;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const focus = field?.cells[field.focusId];
  const cameraPosition = `${focus?.x || 0},${focus?.y || 0}`;
  const [settledPosition, setSettledPosition] = useState<string | null>(cameraPosition);
  useLayoutEffect(() => {
    // Wait for the actual camera transition, including an interrupted pan.
    // With reduced motion or an unchanged position there is nothing to wait for.
    const transitions = cameraElement.current!.getAnimations().filter(animation =>
      animation instanceof CSSTransition && animation.transitionProperty === 'transform');
    if (!transitions.length) {
      setSettledPosition(cameraPosition);
      return;
    }
    setSettledPosition(null);
    let active = true;
    void Promise.allSettled(transitions.map(animation => animation.finished)).then(() => {
      if (active) setSettledPosition(cameraPosition);
    });
    return () => { active = false; };
  }, [cameraPosition]);
  const cells = field ? Object.values(field.cells) : [];
  // Both camera layers share the same inset window for the nine complete cells.
  const tileWidth = size.width / 3;
  const tileHeight = size.height / 3;
  // Percentages let a sidebar/viewport resize recenter immediately; only a
  // changed focus starts the camera transition.
  const camera: CSSProperties = { transform: `translate3d(${(1 - (focus?.x || 0)) * 100 / 3}%, ${(1 - (focus?.y || 0)) * 100 / 3}%, 0)` };
  // Grid and cards move together. The viewport hides the outer border and
  // adjoining cells, leaving only the two inner dividers in each direction.
  const minX = Math.min(0, ...cells.map(cell => cell.x)) - 3;
  const maxX = Math.max(0, ...cells.map(cell => cell.x)) + 3;
  const minY = Math.min(0, ...cells.map(cell => cell.y)) - 3;
  const maxY = Math.max(0, ...cells.map(cell => cell.y)) + 3;
  const grid: CSSProperties = {
    left: minX * tileWidth, top: minY * tileHeight,
    width: (maxX - minX + 1) * tileWidth, height: (maxY - minY + 1) * tileHeight,
    backgroundSize: `${tileWidth}px ${tileHeight}px`,
  };
  return <div className="field-viewport" aria-label="Conversation field">
    <div className="field-grid-viewport" aria-hidden="true">
      <div className={`field-camera ${size.width ? 'measured' : ''}`} style={camera}>
        <div className="field-world-grid" style={grid}/>
      </div>
    </div>
    <div className="field-content-viewport">
    <div className={`field-camera ${size.width ? 'measured' : ''}`} style={camera} ref={cameraElement} data-text-ready={settledPosition === cameraPosition}>
    {!field && <div className="empty-grid" style={{ left: -tileWidth, top: -tileHeight, width: tileWidth * 3, height: tileHeight * 3 }}>
      {Array.from({ length: 9 }, (_, index) => index === 4 ? <section key={index} className="empty-center">
        <h1>{preview || 'Start anywhere.'}</h1>
        <p>{transcript ? topicCaption(transcript) : paused ? 'Turn on the microphone to begin.' : thinking ? 'Finding your next question.' : 'Talk to explore a topic.'}</p>
        {paused && <button type="button" className="empty-microphone" disabled={microphone.disabled} onClick={microphone.onStart}>Microphone On</button>}
      </section> : <div className="empty-cell" key={index}/>)}
    </div>}
      {cells.map(cell => {
        const current = cell.id === field?.focusId;
        const visible = Math.abs(cell.x - (focus?.x || 0)) <= 1 && Math.abs(cell.y - (focus?.y || 0)) <= 1;
        const caption = topicCaption(cell.visited ? cell.summary : cell.question);
        // Replay text entrances on a topic/content change, never on audio levels
        // or interim transcript updates. Keep the world cell itself in place.
        const copyKey = JSON.stringify([visible ? field?.focusId : null, cell.title, caption]);
        return <section key={cell.id} className={`field-cell ${current ? 'current' : ''} ${cell.visited ? 'visited' : ''}`}
          data-cell-id={cell.id} data-world-x={cell.x} data-world-y={cell.y} data-visible={visible} aria-hidden={!visible}
          aria-label={`${current ? 'Current topic' : cell.visited ? 'Explored topic' : 'Blind spot'}: ${cell.title}`}
          style={{ left: cell.x * tileWidth, top: cell.y * tileHeight, width: tileWidth, height: tileHeight }}>
          <div className="cell-copy" key={copyKey} onScroll={event => {
            const overlay = event.currentTarget.parentElement?.querySelector('.focus-copy');
            if (overlay) overlay.scrollTop = event.currentTarget.scrollTop;
          }}><h2>{cell.title}</h2><p>{caption}</p></div>
          {current && <div className="focus-fill" aria-hidden="true">
            <div className="focus-copy" key={copyKey}><div className="focus-title">{cell.title}</div><div className="focus-caption">{caption}</div></div>
          </div>}
        </section>;
      })}
    </div>
    </div>
    <span className="sr-only" role="status">{focus ? `Current topic: ${focus.title}` : 'Waiting for a conversation'}</span>
  </div>;
}
