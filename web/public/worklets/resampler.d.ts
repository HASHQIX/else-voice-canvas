export class CaptureResampler {
  constructor(inputRate: number, outputRate?: number);
  reset(): void;
  push(sample: number, emit: (sample: number) => void): void;
}
