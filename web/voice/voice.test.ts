import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CaptureResampler } from '../public/worklets/resampler.js';
import { Pcm16Decoder } from './pcm.js';
import { MicrophoneCapture } from './capture.js';
import { StreamedPcmPlayer } from './playback.js';

function processor(name: string, sampleRate: number) {
  let Processor: any;
  const messages: any[] = [];
  const source = fs.readFileSync(new URL(`../public/worklets/${name}.js`, import.meta.url), 'utf8').replace(/^import .*;\n/, '');
  vm.runInNewContext(source, {
    sampleRate, CaptureResampler,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: any) => messages.push(message) }; },
    registerProcessor: (_name: string, value: any) => { Processor = value; },
  });
  const instance = new Processor();
  return { instance, messages, send: (data: any) => instance.port.onmessage({ data }) };
}

test('C07: 48/44.1 kHz capture produces actual 16 kHz PCM, continuous phase and anti-aliasing', () => {
  for (const inputRate of [48000, 44100]) {
    const resample = (frequency: number) => {
      const resampler = new CaptureResampler(inputRate);
      const output: number[] = [];
      for (let start = 0; start < inputRate; start += 128) {
        for (let i = start; i < Math.min(start + 128, inputRate); i++) resampler.push(Math.sin(2 * Math.PI * frequency * i / inputRate), sample => output.push(sample));
      }
      assert.ok(Math.abs(output.length - 16000) <= 1, `${inputRate}: ${output.length} samples`);
      return output.slice(500);
    };
    const speech = resample(1000);
    const ultrasonic = resample(12000);
    const rms = (samples: number[]) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    assert.ok(rms(speech) > 0.69, 'The 1 kHz pass band is preserved');
    assert.ok(rms(ultrasonic) < 0.001, 'Above-Nyquist energy is removed before downsampling');
  }
});

test('Capture worklet sends 100 ms little-endian frames, never monitors mic and caps pending audio', () => {
  const capture = processor('pcm-capture', 48000);
  capture.send({ type: 'enabled', value: true });
  for (let frame = 0; frame < 48000 / 128; frame++) {
    const input = new Float32Array(128).fill(0.5);
    const output = new Float32Array(128).fill(9);
    capture.instance.process([[input]], [[output]]);
    assert.ok(output.every(sample => sample === 0), 'No microphone signal is sent to output');
  }
  const packets = capture.messages.filter(message => message.type === 'pcm');
  assert.equal(packets.length, 5, 'At most 500 ms waits for the UI thread');
  assert.ok(packets.every(packet => packet.pcm.byteLength === 3200));
  assert.ok(Math.abs(new DataView(packets[0].pcm).getInt16(1000, true) - 16384) <= 1);
  assert.equal(capture.messages.filter(message => message.type === 'overflow').length, 1);
});

test('C08: arbitrarily odd byte chunks reconstruct the exact PCM samples', () => {
  const samples = [-32768, -1023, -1, 0, 1, 32767];
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  const decoder = new Pcm16Decoder();
  const actual: number[] = [];
  for (const [start, end] of [[0, 1], [1, 4], [4, 4], [4, 5], [5, 10], [10, 11], [11, 12]]) actual.push(...decoder.decode(bytes.subarray(start, end)));
  decoder.finish();
  assert.deepEqual(actual, samples.map(sample => sample / 32768));
  const truncated = new Pcm16Decoder();
  truncated.decode(new Uint8Array([7]));
  assert.throws(() => truncated.finish(), /inside a PCM sample/);
});

test('Playback worklet waits for jitter buffer, converts 24 kHz to device rate, fences interrupted epochs', () => {
  const playback = processor('pcm-playback', 48000);
  playback.send({ type: 'reset', epoch: 4 });
  playback.send({ type: 'pcm', epoch: 4, samples: new Float32Array(1200).fill(0.5) });
  const first = new Float32Array(128);
  playback.instance.process([], [[first]]);
  assert.ok(first.every(sample => sample === 0));
  playback.send({ type: 'pcm', epoch: 4, samples: new Float32Array(1200).fill(0.5) });
  const second = new Float32Array(128);
  playback.instance.process([], [[second]]);
  assert.ok(second.every(sample => sample === 0.5));
  assert.equal(playback.instance.count, 2400 - 64);
  playback.send({ type: 'reset', epoch: 5 });
  playback.send({ type: 'pcm', epoch: 4, samples: new Float32Array(2400).fill(1) });
  const interrupted = new Float32Array(128);
  playback.instance.process([], [[interrupted]]);
  assert.ok(interrupted.every(sample => sample === 0));
  assert.equal(playback.instance.count, 0);
  playback.send({ type: 'pcm', epoch: 5, samples: new Float32Array(48001) });
  assert.equal(playback.messages.at(-1).type, 'error', 'Playback queue cannot exceed two seconds');
});

test('Playback emits a final short buffer rather than waiting forever for 100 ms', () => {
  const playback = processor('pcm-playback', 48000);
  playback.send({ type: 'reset', epoch: 1 });
  playback.send({ type: 'pcm', epoch: 1, samples: new Float32Array(13).fill(0.25) });
  playback.send({ type: 'end', epoch: 1 });
  const output = new Float32Array(128);
  playback.instance.process([], [[output]]);
  assert.ok(output.subarray(0, 26).every(sample => sample === 0.25));
  assert.ok(output.subarray(26).every(sample => sample === 0));
  assert.equal(playback.messages.at(-1).type, 'drained');
});

class MockTrack extends EventTarget {
  readyState = 'live';
  stop() { this.readyState = 'ended'; }
  getSettings() { return { sampleRate: 48000, channelCount: 1, echoCancellation: true }; }
}
class MockNode {
  static all: MockNode[] = [];
  connected = false;
  messages: any[] = [];
  port = {
    onmessage: null as ((event: any) => void) | null,
    postMessage: (data: any) => { this.messages.push(data); },
    close: () => {},
  };
  constructor() { MockNode.all.push(this); }
  connect(target: any) { this.connected = true; return target; }
  disconnect() { this.connected = false; }
}
class MockContext {
  static all: MockContext[] = [];
  state = 'running';
  sampleRate = 48000;
  currentTime = 0;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  gains: any[] = [];
  constructor() { MockContext.all.push(this); }
  async resume() {}
  async close() { this.state = 'closed'; }
  createMediaStreamSource() { return new MockNode(); }
  createGain() {
    const gain = Object.assign(new MockNode(), { gain: { value: 0, cancelScheduledValues() {}, setValueAtTime(value: number) { this.value = value; }, setTargetAtTime(value: number) { this.value = value; } } });
    this.gains.push(gain);
    return gain;
  }
}

function installBrowserMocks() {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const tracks: MockTrack[] = [];
  const devices = Object.assign(new EventTarget(), { getUserMedia: async () => {
    const track = new MockTrack(); tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  } });
  for (const [key, value] of Object.entries({ navigator: { mediaDevices: devices }, AudioContext: MockContext, AudioWorkletNode: MockNode, WebSocket: { OPEN: 1 } })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return { tracks, restore() { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } };
}

test('C06: five microphone start/stop cycles close every track, context and node', async () => {
  const mocks = installBrowserMocks();
  const contextsStart = MockContext.all.length;
  const nodesStart = MockNode.all.length;
  try {
    const socket = Object.assign(new EventTarget(), { readyState: 1, bufferedAmount: 0, send() {} });
    const capture = new MicrophoneCapture();
    for (let i = 0; i < 5; i++) {
      await capture.start(socket as any);
      capture.setReady(true);
      assert.equal(capture.getSettings()?.contextSampleRate, 48000);
      assert.equal(capture.getSettings()?.outputSampleRate, 16000);
      await capture.stop();
    }
    assert.equal(capture.active, false);
    assert.equal(mocks.tracks.length, 5);
    assert.ok(mocks.tracks.every(track => track.readyState === 'ended'));
    assert.ok(MockContext.all.slice(contextsStart).every(context => context.state === 'closed'));
    assert.ok(MockNode.all.slice(nodesStart).every(node => !node.connected));
  } finally { mocks.restore(); }
});

test('A06: stop immediately mutes PCM, aborts the fetch and rejects late stream chunks', async () => {
  const mocks = installBrowserMocks();
  const originalFetch = globalThis.fetch;
  let release: ((response: Response) => void) | undefined;
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal as AbortSignal;
    return new Promise<Response>(resolve => { release = resolve; });
  };
  try {
    const player = new StreamedPcmPlayer();
    await player.unlock();
    const playback = player.play('/api/replies/r/audio');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const node = [...MockNode.all].reverse().find(node => node.messages.some(message => message.type === 'reset'))!;
    const context = MockContext.all.at(-1)!;
    player.stop();
    assert.equal(signal!.aborted, true);
    assert.equal(context.gains[0].gain.value, 0);
    release(new Response(new Uint8Array(4800)));
    await playback;
    assert.equal(node.messages.filter(message => message.type === 'pcm').length, 0);
    await player.dispose();
    assert.equal(context.state, 'closed');
  } finally { globalThis.fetch = originalFetch; mocks.restore(); }
});

test('Capture permission resolving after stop releases the late microphone track', async () => {
  const mocks = installBrowserMocks();
  let grant: ((stream: any) => void) | undefined;
  const track = new MockTrack();
  navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  try {
    const socket = Object.assign(new EventTarget(), { readyState: 1, bufferedAmount: 0, send() {} });
    const capture = new MicrophoneCapture();
    const starting = capture.start(socket as any);
    while (!grant) await new Promise(resolve => setImmediate(resolve));
    const context = MockContext.all.at(-1)!;
    await capture.stop();
    grant({ getTracks: () => [track], getAudioTracks: () => [track] });
    await starting;
    assert.equal(track.readyState, 'ended');
    assert.equal(context.state, 'closed');
    assert.equal(capture.active, false);
  } finally { mocks.restore(); }
});

test('Concurrent microphone starts cannot leave an orphan AudioContext', async () => {
  const mocks = installBrowserMocks();
  const start = MockContext.all.length;
  try {
    const socket = Object.assign(new EventTarget(), { readyState: 1, bufferedAmount: 0, send() {} });
    const capture = new MicrophoneCapture();
    await Promise.all([capture.start(socket as any), capture.start(socket as any)]);
    await capture.stop();
    assert.ok(MockContext.all.slice(start).every(context => context.state === 'closed'));
    assert.ok(mocks.tracks.every(track => track.readyState === 'ended'));
  } finally { mocks.restore(); }
});

test('Capture refuses an overloaded socket and releases microphone resources', async () => {
  const mocks = installBrowserMocks();
  let closed = 0;
  let sent = 0;
  let reported = '';
  try {
    const socket = Object.assign(new EventTarget(), { readyState: 1, bufferedAmount: 16000, send() { sent++; }, close(code: number) { closed = code; } });
    const capture = new MicrophoneCapture({ onError: error => { reported = error.message; } });
    await capture.start(socket as any);
    capture.setReady(true);
    const worklet = MockNode.all.at(-1)!;
    worklet.port.onmessage!({ data: { type: 'pcm', pcm: new ArrayBuffer(3200) } });
    assert.equal(sent, 0);
    assert.equal(closed, 4001);
    assert.match(reported, /too slow/);
    assert.equal(capture.active, false);
    assert.ok(mocks.tracks.every(track => track.readyState === 'ended'));
    await capture.stop();
  } finally { mocks.restore(); }
});
