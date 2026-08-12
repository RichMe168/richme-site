(function attachRecorderAdapter(root) {
  "use strict";

  function audioInputConstraints() {
    return {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    };
  }

  function summarizeTrack(track) {
    if (!track) return { enabled: false, muted: false, readyState: "missing", live: false };
    const enabled = track.enabled !== false;
    const muted = Boolean(track.muted);
    const readyState = String(track.readyState || "unknown");
    return { enabled, muted, readyState, live: enabled && !muted && readyState === "live" };
  }

  function streamHasLiveAudioTrack(stream) {
    if (!stream || stream.active === false || typeof stream.getTracks !== "function") return false;
    return stream.getTracks().some((track) => track && track.kind === "audio" && summarizeTrack(track).live);
  }

  class RecorderAdapter {
    constructor(options) {
      this.MediaRecorderCtor = options && options.MediaRecorderCtor;
      this.stream = options && options.stream;
      this.mimeType = options && options.mimeType || "";
      this.recorder = null;
      this.chunks = [];
    }

    create() {
      if (!this.MediaRecorderCtor) throw new Error("MediaRecorderUnavailable");
      if (!streamHasLiveAudioTrack(this.stream)) throw new Error("MicStreamInactive");
      const options = this.mimeType ? { mimeType: this.mimeType } : undefined;
      this.recorder = new this.MediaRecorderCtor(this.stream, options);
      this.chunks = [];
      if (typeof this.recorder.addEventListener === "function") {
        this.recorder.addEventListener("dataavailable", (event) => {
          if (event && event.data && event.data.size) this.chunks.push(event.data);
        });
      }
      return this.recorder;
    }

    start() {
      if (!this.recorder) this.create();
      this.recorder.start();
      return this.recorder.state;
    }

    stop() {
      if (!this.recorder || this.recorder.state === "inactive") return "inactive";
      this.recorder.stop();
      return this.recorder.state;
    }

    dispose() {
      this.recorder = null;
      this.chunks = [];
    }
  }

  const api = Object.freeze({ RecorderAdapter, audioInputConstraints, streamHasLiveAudioTrack, summarizeTrack });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.XiaoRuiRecorderAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
