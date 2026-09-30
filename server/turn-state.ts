/** ASR Turn is a replacement snapshot. Final segments form one user thought. */
export type TurnEvent = { turn_order: number; transcript: string; end_of_turn: boolean };
export type ThoughtToken = { group: number; revision: number; semanticEpoch: number; text: string };
export type CompletedToken = ThoughtToken & { segments: Array<{ order: number; text: string }> };
export class ThoughtBuffer {
  private segments = new Map<number, { text: string; final: boolean }>();
  private committedOrders = new Set<number>();
  group = 0;
  revision = 0;
  semanticEpoch = 0;
  hold = false;
  get text() { return [...this.segments].sort(([a], [b]) => a - b).map(([, s]) => s.text).join(' ').trim(); }
  get allFinal() { return this.segments.size > 0 && [...this.segments.values()].every(s => s.final); }
  update(event: TurnEvent): boolean {
    if (this.committedOrders.has(event.turn_order)) return false;
    const previous = this.segments.get(event.turn_order);
    if (previous?.final && !event.end_of_turn) return false;
    if (previous?.text === event.transcript && previous.final === event.end_of_turn) return false;
    const before = this.text;
    this.segments.set(event.turn_order, { text: event.transcript, final: event.end_of_turn });
    const after = this.text;
    if (after !== before) {
      this.revision++;
      // A rewritten prefix or an explicit correction invalidates earlier semantic meaning.
      const newSuffix = after.startsWith(before) ? after.slice(before.length) : after;
      if ((before && !after.startsWith(before)) || /(?:\bno\b|\bnot\b|\binstead\b|\bactually\b|\bmore precisely\b|\bi mean\b)/iu.test(newSuffix)) this.semanticEpoch++;
    }
    return true;
  }
  token(): ThoughtToken { return { group: this.group, revision: this.revision, semanticEpoch: this.semanticEpoch, text: this.text }; }
  acceptsPreview(token: ThoughtToken): boolean {
    return token.group === this.group && token.semanticEpoch === this.semanticEpoch && this.text.startsWith(token.text);
  }
  acceptsFinal(token: ThoughtToken): boolean {
    return token.group === this.group && token.revision === this.revision && token.text === this.text && this.allFinal;
  }
  /** A stable ASR prefix can be analyzed while later speech keeps arriving. */
  completedToken(): CompletedToken | null {
    const segments: CompletedToken['segments'] = [];
    for (const [order, segment] of [...this.segments].sort(([a], [b]) => a - b)) {
      if (!segment.final) break;
      segments.push({ order, text: segment.text });
    }
    const text = segments.map(segment => segment.text).join(' ').trim();
    return text ? { ...this.token(), text, segments } : null;
  }
  acceptsCompleted(token: CompletedToken): boolean {
    if (token.group !== this.group || token.semanticEpoch !== this.semanticEpoch) return false;
    const current = [...this.segments].sort(([a], [b]) => a - b);
    return token.segments.every((segment, index) => {
      const item = current[index];
      return item?.[0] === segment.order && item[1].final && item[1].text === segment.text;
    });
  }
  commitCompleted(token: CompletedToken): boolean {
    if (!this.acceptsCompleted(token)) return false;
    for (const segment of token.segments) {
      this.committedOrders.add(segment.order);
      this.segments.delete(segment.order);
    }
    this.group++; this.revision = 0; this.semanticEpoch++;
    return true;
  }
  commit(token: ThoughtToken): boolean {
    if (!this.acceptsFinal(token)) return false;
    for (const order of this.segments.keys()) this.committedOrders.add(order);
    this.segments.clear(); this.group++; this.revision = 0; this.semanticEpoch++;
    return true;
  }
  reset() { this.segments.clear(); this.committedOrders.clear(); this.group++; this.revision = 0; this.semanticEpoch++; }
}
