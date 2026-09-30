/** The fetch transport can split a signed little-endian sample between arbitrary chunks. */
export class Pcm16Decoder {
  private carry: number | null = null;

  decode(bytes: Uint8Array): Float32Array {
    const output = new Float32Array(Math.floor((bytes.length + (this.carry === null ? 0 : 1)) / 2));
    let inputIndex = 0;
    let outputIndex = 0;
    const sample = (low: number, high: number) => {
      const unsigned = low | (high << 8);
      return (unsigned >= 32768 ? unsigned - 65536 : unsigned) / 32768;
    };
    if (this.carry !== null && bytes.length) {
      output[outputIndex++] = sample(this.carry, bytes[inputIndex++]);
      this.carry = null;
    }
    while (inputIndex + 1 < bytes.length) {
      output[outputIndex++] = sample(bytes[inputIndex], bytes[inputIndex + 1]);
      inputIndex += 2;
    }
    if (inputIndex < bytes.length) this.carry = bytes[inputIndex];
    return output;
  }

  finish(): void {
    if (this.carry !== null) throw new Error('The response audio ended inside a PCM sample');
  }
}
