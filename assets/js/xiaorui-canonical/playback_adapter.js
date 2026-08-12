(function attachPlaybackAdapter(root) {
  "use strict";

  function pcm16leBytesToFloat32(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (data.byteLength % 2 !== 0) throw new Error("InvalidPCM16Audio");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const samples = new Float32Array(data.byteLength / 2);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = view.getInt16(index * 2, true);
      samples[index] = Math.max(-1, Math.min(1, sample / 32768));
    }
    return samples;
  }

  class PcmPlaybackAdapter {
    constructor(options) {
      this.context = options && options.audioContext;
      this.destination = options && options.destination || this.context && this.context.destination;
      this.activeSources = new Set();
      this.nextScheduledTime = 0;
      this.safetySeconds = options && Number.isFinite(options.safetySeconds) ? options.safetySeconds : 0.12;
    }

    schedulePcmBytes(options) {
      const sourceOptions = options || {};
      if (!this.context) throw new Error("AudioContextUnavailable");
      const sampleRate = Number(sourceOptions.sampleRate || 24000);
      const samples = pcm16leBytesToFloat32(sourceOptions.pcmBytes || new Uint8Array());
      const buffer = this.context.createBuffer(1, samples.length, sampleRate);
      if (typeof buffer.copyToChannel === "function") buffer.copyToChannel(samples, 0);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      if (typeof source.connect === "function") source.connect(this.destination);
      const currentTime = Number(this.context.currentTime || 0);
      const scheduledStart = Math.max(currentTime + this.safetySeconds, this.nextScheduledTime || 0);
      const duration = Number(buffer.duration || (samples.length / sampleRate));
      this.nextScheduledTime = scheduledStart + duration;
      this.activeSources.add(source);
      source.onended = () => {
        this.activeSources.delete(source);
        if (typeof sourceOptions.onEnded === "function") sourceOptions.onEnded(source);
      };
      if (typeof source.start === "function") source.start(scheduledStart);
      return { source, scheduledStart, scheduledEnd: this.nextScheduledTime, duration };
    }

    stopAll() {
      this.activeSources.forEach((source) => {
        try { if (typeof source.stop === "function") source.stop(); } catch (error) { /* already stopped */ }
      });
      this.activeSources.clear();
      this.nextScheduledTime = 0;
    }
  }

  const api = Object.freeze({ PcmPlaybackAdapter, pcm16leBytesToFloat32 });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.XiaoRuiPlaybackAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
