/** ASR Turn is a replacement snapshot. Final segments form one user thought. */
export type TurnEvent = { turn_order: number; transcript: string; end_of_turn: boolean };
export type ThoughtToken = { group: number; revision: number; semanticEpoch: number; text: string };
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
  commit(token: ThoughtToken): boolean {
    if (!this.acceptsFinal(token)) return false;
    for (const order of this.segments.keys()) this.committedOrders.add(order);
    this.segments.clear(); this.group++; this.revision = 0; this.semanticEpoch++;
    return true;
  }
  reset() { this.segments.clear(); this.committedOrders.clear(); this.group++; this.revision = 0; this.semanticEpoch++; }
}
