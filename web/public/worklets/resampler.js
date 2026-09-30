/** Stateful, low-pass filtered resampler. Never assumes the capture device is 16 kHz. */
export class CaptureResampler {
  constructor(inputRate, outputRate = 16000) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new Error('Invalid sample rate');
    this.step = inputRate / outputRate;
    this.taps = 95;
    this.history = new Float32Array(this.taps);
    this.coefficients = new Float64Array(this.taps);
    const cutoff = Math.min(outputRate * 0.45, inputRate * 0.45) / inputRate;
    const middle = (this.taps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < this.taps; i++) {
      const distance = i - middle;
      const sinc = distance === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
      const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (this.taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (this.taps - 1));
      this.coefficients[i] = sinc * window;
      sum += this.coefficients[i];
    }
    for (let i = 0; i < this.taps; i++) this.coefficients[i] /= sum;
    this.reset();
  }

  reset() {
    this.history.fill(0);
    this.head = 0;
    this.index = 0;
    this.nextOutput = 0;
    this.previous = 0;
  }

  /** One source sample in, zero or more destination samples out; phase survives blocks. */
  push(sample, emit) {
    this.history[this.head] = Number.isFinite(sample) ? sample : 0;
    let filtered = 0;
    let at = this.head;
    for (let i = 0; i < this.taps; i++) {
      filtered += this.history[at] * this.coefficients[i];
      if (--at < 0) at = this.taps - 1;
    }
    this.head = (this.head + 1) % this.taps;
    while (this.nextOutput <= this.index) {
      const fraction = this.index === 0 ? 1 : this.nextOutput - (this.index - 1);
      emit(this.previous + (filtered - this.previous) * fraction);
      this.nextOutput += this.step;
    }
    this.previous = filtered;
    this.index++;
  }
}
