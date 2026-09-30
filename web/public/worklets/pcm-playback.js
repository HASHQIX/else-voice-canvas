class ElsePlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(48000); // At most two seconds of 24 kHz PCM.
    this.epoch = 0;
    this.reset();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'reset') {
        this.epoch = data.epoch;
        this.reset();
      } else if (data.epoch === this.epoch && data.type === 'pcm') {
        if (this.count + data.samples.length > this.ring.length) {
          this.port.postMessage({ type: 'error', epoch: this.epoch, message: 'PCM playback overflow' });
          return;
        }
        for (const sample of data.samples) {
          this.ring[this.write] = sample;
          this.write = (this.write + 1) % this.ring.length;
        }
        this.count += data.samples.length;
      } else if (data.epoch === this.epoch && data.type === 'end') {
        this.ended = true;
      }
    };
  }

  reset() {
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.position = 0;
    this.started = false;
    this.ended = false;
    this.drained = false;
    this.consumed = 0;
    this.reportFrames = 0;
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    if (!channels?.length) return true;
    const output = channels[0];
    output.fill(0);
    if (!this.started && (this.count >= 2400 || this.ended)) this.started = true;
    if (this.started) {
      for (let i = 0; i < output.length; i++) {
        if (this.count < 2 && !this.ended) {
          this.started = false;
          break;
        }
        if (this.count === 0) break;
        const first = this.ring[this.read];
        const second = this.count > 1 ? this.ring[(this.read + 1) % this.ring.length] : first;
        output[i] = first + (second - first) * this.position;
        this.position += 24000 / sampleRate;
        const advance = Math.min(this.count, Math.floor(this.position));
        this.read = (this.read + advance) % this.ring.length;
        this.count -= advance;
        this.position -= advance;
        this.consumed += advance;
      }
    }
    for (let i = 1; i < channels.length; i++) channels[i].set(output);
    this.reportFrames += output.length;
    if (this.reportFrames >= sampleRate * 0.02 || (this.ended && this.count === 0)) {
      if (this.consumed) this.port.postMessage({ type: 'consumed', epoch: this.epoch, samples: this.consumed });
      this.consumed = 0;
      this.reportFrames = 0;
    }
    if (this.ended && this.count === 0 && !this.drained) {
      this.drained = true;
      this.port.postMessage({ type: 'drained', epoch: this.epoch });
    }
    return true;
  }
}

registerProcessor('else-pcm-playback', ElsePlaybackProcessor);
