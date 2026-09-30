export type CaptureStatus = 'requesting' | 'waiting' | 'streaming' | 'stopped';
export type CaptureOptions = {
  onLevel?: (level: number, speaking: boolean) => void;
  onStatus?: (status: CaptureStatus) => void;
  onError?: (error: Error) => void;
};

/** One AudioWorklet owns capture and actual-rate resampling; no recording container is involved. */
export class MicrophoneCapture {
  private epoch = 0;
  private ready = false;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private socket: WebSocket | null = null;
  private settings: (MediaTrackSettings & { contextSampleRate: number; outputSampleRate: 16000 }) | null = null;
  private flushes = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private handleSocketClose = () => { void this.stop(); };
  private handleTrackEnd = () => this.fail(new Error('The microphone was disconnected. Reconnect it and start a new session.'));
  private handleDeviceChange = () => {
    if (this.stream?.getAudioTracks().every(track => track.readyState === 'ended')) this.handleTrackEnd();
    else if (this.stream && this.context) {
      this.settings = { ...this.stream.getAudioTracks()[0].getSettings(), contextSampleRate: this.context.sampleRate, outputSampleRate: 16000 };
    }
  };

  constructor(private readonly options: CaptureOptions = {}) {}

  getSettings() { return this.settings; }
  get active() { return this.stream !== null; }

  async start(socket: WebSocket): Promise<void> {
    await this.stop();
    const epoch = ++this.epoch;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires HTTPS or localhost.');
    if (!globalThis.AudioWorkletNode) throw new Error('This browser does not support AudioWorklet.');
    this.options.onStatus?.('requesting');
    this.socket = socket;
    socket.addEventListener('close', this.handleSocketClose);
    const context = new AudioContext({ latencyHint: 'interactive' });
    this.context = context;
    try {
      await context.resume();
      if (epoch !== this.epoch) { if (context.state !== 'closed') await context.close().catch(() => {}); return; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (epoch !== this.epoch) {
        stream.getTracks().forEach(track => track.stop());
        if (context.state !== 'closed') await context.close().catch(() => {});
        return;
      }
      this.stream = stream;
      for (const track of stream.getTracks()) track.addEventListener('ended', this.handleTrackEnd);
      navigator.mediaDevices.addEventListener('devicechange', this.handleDeviceChange);
      this.settings = { ...stream.getAudioTracks()[0].getSettings(), contextSampleRate: context.sampleRate, outputSampleRate: 16000 };
      await context.audioWorklet.addModule('/worklets/pcm-capture.js');
      if (epoch !== this.epoch) {
        stream.getTracks().forEach(track => track.stop());
        if (context.state !== 'closed') await context.close().catch(() => {});
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, 'else-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
      this.source = source;
      this.worklet = worklet;
      worklet.port.onmessage = ({ data }) => {
        if (epoch !== this.epoch) return;
        if (data.type === 'level') this.options.onLevel?.(data.level, data.speaking);
        if (data.type === 'overflow') this.fail(new Error('Audio capture could not keep up. Please repeat the unfinished thought.'));
        if (data.type === 'flushed') {
          const pending = this.flushes.get(data.id);
          if (pending) { clearTimeout(pending.timer); pending.resolve(); this.flushes.delete(data.id); }
        }
        if (data.type === 'pcm') {
          try {
            if (this.ready && socket.readyState === WebSocket.OPEN) {
              if (socket.bufferedAmount + data.pcm.byteLength > 16000) {
                this.fail(new Error('Audio network transport is too slow. Please repeat the unfinished thought.'));
                return;
              }
              socket.send(data.pcm);
            }
          } catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
          } finally { worklet.port.postMessage({ type: 'credit' }); }
        }
      };
      source.connect(worklet);
      // The worklet explicitly writes only zeroes to its output. Capture is never monitored.
      worklet.connect(context.destination);
      worklet.port.postMessage({ type: 'enabled', value: this.ready });
      this.options.onStatus?.(this.ready ? 'streaming' : 'waiting');
    } catch (error) {
      if (epoch !== this.epoch) { if (context.state !== 'closed') await context.close().catch(() => {}); return; }
      await this.stop();
      throw error;
    }
  }

  /** Call only after the backend confirms STT Begin. Before readiness, samples are discarded. */
  setReady(ready: boolean): void {
    this.ready = ready;
    this.worklet?.port.postMessage({ type: 'enabled', value: ready });
    if (this.worklet) this.options.onStatus?.(ready ? 'streaming' : 'waiting');
  }

  /** Preserve the final partial capture block before sending ForceEndpoint/Terminate. */
  async flush(): Promise<void> {
    if (!this.worklet || !this.ready) return;
    const id = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.flushes.delete(id); reject(new Error('Microphone flush timed out')); }, 400);
      this.flushes.set(id, { resolve, reject, timer });
      this.worklet!.port.postMessage({ type: 'flush', id });
    });
  }

  private fail(error: Error): void {
    const socket = this.socket;
    void this.stop();
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(4001, 'audio_transport_failed');
    this.options.onError?.(error);
  }

  async stop(): Promise<void> {
    ++this.epoch;
    this.ready = false;
    this.socket?.removeEventListener('close', this.handleSocketClose);
    this.socket = null;
    for (const item of this.flushes.values()) { clearTimeout(item.timer); item.reject(new Error('Microphone capture stopped')); }
    this.flushes.clear();
    const worklet = this.worklet;
    this.worklet = null;
    if (worklet) { worklet.port.onmessage = null; worklet.port.postMessage({ type: 'stop' }); worklet.disconnect(); worklet.port.close(); }
    this.source?.disconnect();
    this.source = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) { track.removeEventListener('ended', this.handleTrackEnd); track.stop(); }
      this.stream = null;
    }
    navigator.mediaDevices?.removeEventListener('devicechange', this.handleDeviceChange);
    const context = this.context;
    this.context = null;
    this.options.onLevel?.(0, false);
    this.options.onStatus?.('stopped');
    if (context && context.state !== 'closed') await context.close().catch(() => {});
  }
}
