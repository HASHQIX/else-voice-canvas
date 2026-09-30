import { CaptureResampler } from './resampler.js';

class ElseCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new CaptureResampler(sampleRate, 16000);
    this.frame = new ArrayBuffer(3200);
    this.view = new DataView(this.frame);
    this.frameSamples = 0;
    this.enabled = false;
    this.closed = false;
    this.credits = 5; // No more than 500 ms can wait in MessagePort.
    this.overloaded = false;
    this.meterSamples = 0;
    this.meterPower = 0;
    this.speechRemaining = 0;
    this.emitSample = value => {
      const clamped = Math.max(-1, Math.min(1, value));
      this.view.setInt16(this.frameSamples * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
      if (++this.frameSamples === 1600) this.emitFrame();
    };
    this.port.onmessage = ({ data }) => {
      if (data.type === 'enabled') {
        this.enabled = Boolean(data.value);
        this.frameSamples = 0;
        this.resampler.reset();
      } else if (data.type === 'credit') {
        this.credits = Math.min(5, this.credits + 1);
      } else if (data.type === 'flush') {
        if (this.enabled) this.emitFrame();
        this.port.postMessage({ type: 'flushed', id: data.id });
      } else if (data.type === 'stop') {
        this.enabled = false;
        this.closed = true;
      }
    };
  }

  emitFrame() {
    if (!this.frameSamples) return;
    if (this.credits > 0) {
      const pcm = this.frameSamples === 1600 ? this.frame : this.frame.slice(0, this.frameSamples * 2);
      this.port.postMessage({ type: 'pcm', pcm }, [pcm]);
      this.credits--;
    } else if (!this.overloaded) {
      this.overloaded = true;
      this.port.postMessage({ type: 'overflow' });
    }
    this.frame = new ArrayBuffer(3200);
    this.view = new DataView(this.frame);
    this.frameSamples = 0;
  }

  process(inputs, outputs) {
    // A silent output keeps this node scheduled. Microphone samples never reach the speakers.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.closed) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] / channels.length;
      this.meterPower += mono * mono;
      this.meterSamples++;
      if (this.enabled) this.resampler.push(mono, this.emitSample);
    }
    if (this.meterSamples >= sampleRate * 0.05) {
      const rms = Math.sqrt(this.meterPower / this.meterSamples);
      this.speechRemaining = rms > 0.025 ? sampleRate * 0.2 : Math.max(0, this.speechRemaining - this.meterSamples);
      this.port.postMessage({ type: 'level', level: Math.min(1, rms * 5), speaking: this.speechRemaining > 0 });
      this.meterSamples = 0;
      this.meterPower = 0;
    }
    return true;
  }
}

registerProcessor('else-pcm-capture', ElseCaptureProcessor);
