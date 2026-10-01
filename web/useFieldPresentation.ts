import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { ConversationField } from '../shared/field';
import { advancePresentation, finishFlip, initialPresentation, nextPresentationAt, reconcilePresentation } from './field-presentation';

export function useFieldPresentation(field?: ConversationField) {
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [presentation, setPresentation] = useState(() => initialPresentation(field, performance.now(), reducedMotion));
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReducedMotion(media.matches);
    media.addEventListener('change', changed);
    changed();
    return () => media.removeEventListener('change', changed);
  }, []);
  useLayoutEffect(() => {
    setPresentation(previous => reconcilePresentation(previous, field, performance.now(), reducedMotion));
  }, [field, reducedMotion]);
  useEffect(() => {
    const at = nextPresentationAt(presentation);
    if (at === undefined) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = performance.now();
      if (now < at) { timer = setTimeout(tick, Math.max(1, Math.ceil(at - now))); return; }
      setPresentation(previous => advancePresentation(previous, now));
    };
    timer = setTimeout(tick, Math.max(1, Math.ceil(at - performance.now())));
    return () => clearTimeout(timer);
  }, [presentation]);
  const completeFlip = useCallback((index: number, version: number) => {
    setPresentation(previous => finishFlip(previous, index, version, performance.now()));
  }, []);
  return { presentation, completeFlip };
}
