"use strict";

/**
 * Fixed-hop tap. Runs on the audio thread, so hops are sample-exact and
 * immune to main-thread jank. Downmixes to mono and posts one message per
 * hop; the buffer is reused because structured clone copies it.
 */
class ScvizTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const hop = options?.processorOptions?.hop;
    this.hop = Number.isFinite(hop) && hop >= 128 ? hop | 0 : 512;
    this.buf = new Float32Array(this.hop);
    this.n = 0;
    this.index = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const a = input[0];
    if (!a) return true;
    const b = input.length > 1 ? input[1] : null;
    const len = a.length;
    const hop = this.hop;
    const buf = this.buf;
    let n = this.n;
    for (let i = 0; i < len; i++) {
      buf[n++] = b ? (a[i] + b[i]) * 0.5 : a[i];
      if (n === hop) {
        // currentTime is the audio clock at the start of this render quantum.
        this.port.postMessage({ t: currentTime, i: this.index++, s: buf });
        n = 0;
      }
    }
    this.n = n;
    return true;
  }
}

registerProcessor("scviz-tap", ScvizTapProcessor);
