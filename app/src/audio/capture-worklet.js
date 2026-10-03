// AudioWorklet: forwards mono mic audio to the main thread in ~2048-sample chunks
// (at the context's native rate). Resampling to 16 kHz happens on the main thread
// (resampler.js) so the exact same code can be tested in Node and mirrored in Python.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(2048);
    this.len = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (channels && channels.length) {
      const n = channels[0].length;
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let c = 0; c < channels.length; c++) v += channels[c][i];
        this.chunk[this.len++] = v / channels.length;
        if (this.len === this.chunk.length) {
          this.port.postMessage(this.chunk, [this.chunk.buffer]);
          this.chunk = new Float32Array(2048);
          this.len = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('firefly-capture', CaptureProcessor);
