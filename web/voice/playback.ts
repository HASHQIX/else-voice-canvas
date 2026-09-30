import { Pcm16Decoder } from './pcm.js';

export type PlaybackOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  onStart?: () => void;
  onEnd?: () => void;
};
const abortError = () => new DOMException('Response playback interrupted', 'AbortError');

/** Streams backend PCM16/24 kHz with a 100 ms jitter buffer and two-second worklet ring. */
export class StreamedPcmPlayer {
  private epoch = 0;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private loading: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private queued = 0;
  private drained = false;
  private ducked = false;
  private playing = false;
  private listeners = new Set<() => void>();

  get active() { return this.playing; }

  /** Call inside the user's microphone/sound gesture so subsequent stream playback is allowed. */
  async unlock(): Promise<void> {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      const context = this.context;
      this.loading = context.audioWorklet.addModule('/worklets/pcm-playback.js').then(() => {
        if (this.context !== context || context.state === 'closed') return;
        this.node = new AudioWorkletNode(context, 'else-pcm-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
        this.gain = context.createGain();
        this.gain.gain.value = 0;
        this.node.connect(this.gain).connect(context.destination);
        this.node.port.onmessage = ({ data }) => {
          if (data.epoch !== this.epoch) return;
          if (data.type === 'consumed') this.queued = Math.max(0, this.queued - data.samples);
          if (data.type === 'drained') this.drained = true;
          if (data.type === 'error') this.abort?.abort(new Error(data.message));
          this.notify();
        };
      }).catch(async error => {
        if (this.context === context) { this.loading = null; this.context = null; }
        if (context.state !== 'closed') await context.close().catch(() => {});
        throw error;
      });
    }
    await this.context.resume();
    await this.loading;
    if (!this.node) throw new Error('Audio playback did not initialize');
  }

  private notify() { for (const listener of this.listeners) listener(); }

  private waitUntil(predicate: () => boolean, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.listeners.delete(check); signal.removeEventListener('abort', check); };
      const check = () => {
        if (signal.aborted) { cleanup(); reject(signal.reason || abortError()); }
        else if (predicate()) { cleanup(); resolve(); }
      };
      this.listeners.add(check);
      signal.addEventListener('abort', check, { once: true });
      check();
    });
  }

  async play(url: string, options: PlaybackOptions = {}): Promise<void> {
    this.stop();
    const epoch = this.epoch;
    const abort = new AbortController();
    this.abort = abort;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await this.unlock();
      if (epoch !== this.epoch || abort.signal.aborted) return;
      this.node!.port.postMessage({ type: 'reset', epoch });
      this.queued = 0;
      this.drained = false;
      this.playing = true;
      this.gain!.gain.setValueAtTime(this.ducked ? 0.18 : 1, this.context!.currentTime);
      const response = await fetch(url, { method: options.body === undefined ? 'GET' : 'POST', credentials: 'include', headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: abort.signal });
      if (!response.ok || !response.body) throw new Error(`Response audio unavailable (${response.status})`);
      if (epoch !== this.epoch) { await response.body.cancel().catch(() => {}); return; }
      reader = response.body.getReader();
      const decoder = new Pcm16Decoder();
      let announced = false;
      while (true) {
        // Do not continue draining fetch while the playback queue is full.
        await this.waitUntil(() => this.queued <= 45600, abort.signal);
        const next = await reader.read();
        if (epoch !== this.epoch || abort.signal.aborted) return;
        if (next.done) break;
        for (let offset = 0; offset < next.value.length; offset += 4800) {
          const samples = decoder.decode(next.value.subarray(offset, offset + 4800));
          if (!samples.length) continue;
          await this.waitUntil(() => this.queued + samples.length <= 48000, abort.signal);
          if (epoch !== this.epoch || abort.signal.aborted) return;
          this.queued += samples.length;
          this.node!.port.postMessage({ type: 'pcm', epoch, samples }, [samples.buffer]);
          if (!announced) { announced = true; options.onStart?.(); }
        }
      }
      decoder.finish();
      this.node!.port.postMessage({ type: 'end', epoch });
      await this.waitUntil(() => this.drained, abort.signal);
      if (epoch === this.epoch) options.onEnd?.();
    } catch (error) {
      if (epoch === this.epoch && !abort.signal.aborted) { this.stop(); throw error; }
      if (abort.signal.aborted && abort.signal.reason?.name !== 'AbortError' && epoch === this.epoch) { this.stop(); throw abort.signal.reason; }
    } finally {
      await reader?.cancel().catch(() => {});
      if (epoch === this.epoch) { this.playing = false; this.abort = null; }
    }
  }

  /** Local level may duck promptly; only server SpeechStarted should cancel the semantic reply. */
  setDucked(ducked: boolean): void {
    this.ducked = ducked;
    if (this.gain && this.context) {
      const now = this.context.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setTargetAtTime(this.playing ? (ducked ? 0.18 : 1) : 0, now, 0.008);
    }
  }

  /** Immediate gain cutoff plus epoch fence; no old chunk can revive interrupted playback. */
  stop(): void {
    ++this.epoch;
    this.abort?.abort(abortError());
    this.abort = null;
    this.playing = false;
    this.queued = 0;
    this.drained = false;
    if (this.gain && this.context) { this.gain.gain.cancelScheduledValues(this.context.currentTime); this.gain.gain.setValueAtTime(0, this.context.currentTime); }
    this.node?.port.postMessage({ type: 'reset', epoch: this.epoch });
    this.notify();
  }

  async dispose(): Promise<void> {
    this.stop();
    const context = this.context;
    this.context = null;
    if (this.node) { this.node.port.onmessage = null; this.node.port.close(); this.node.disconnect(); }
    this.node = null;
    this.gain?.disconnect();
    this.gain = null;
    this.loading = null;
    if (context && context.state !== 'closed') await context.close().catch(() => {});
  }
}
