"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class MockElement {
  constructor() {
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.paragraph = null;
  }

  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
  append(...children) { this.children.push(...children); }
  querySelector(selector) {
    if (selector !== "p") return null;
    if (!this.paragraph) this.paragraph = new MockElement();
    return this.paragraph;
  }
}

const mediaInstances = [];
class MockAudio {
  constructor(url) {
    this.url = url;
    this.onended = null;
    this.onerror = null;
    this.paused = false;
    mediaInstances.push(this);
  }

  play() { return Promise.resolve(); }
  pause() { this.paused = true; }
  finish() { if (this.onended) this.onended(); }
}

const sources = [];
class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = "running";
    this.destination = {};
  }

  createBuffer(_channels, length, sampleRate) {
    return { duration: length / sampleRate, copyToChannel() {} };
  }

  createBufferSource() {
    const source = {
      listeners: {},
      connect() {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      start(startAt) { this.startAt = startAt; sources.push(this); },
      stop() { if (this.listeners.ended) this.listeners.ended(); },
      finish(context) {
        context.currentTime = this.startAt + this.buffer.duration;
        if (this.listeners.ended) this.listeners.ended();
      }
    };
    return source;
  }

  resume() { this.state = "running"; return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
}

const selectors = new Map();
for (const selector of [
  "[data-xiaorui-launch]",
  "[data-xiaorui-panel]",
  "[data-xiaorui-close]",
  "[data-xiaorui-status-wrap]",
  "[data-xiaorui-status]",
  "[data-xiaorui-transcript]",
  "[data-xiaorui-hint]",
  "[data-xiaorui-voice]",
  "[data-xiaorui-voice-label]",
  "[data-xiaorui-retry]"
]) selectors.set(selector, new MockElement());

const root = { querySelector: (selector) => selectors.get(selector) || null };
const documentMock = {
  addEventListener() {},
  createElement: () => new MockElement(),
  querySelector: () => null
};
const windowMock = {
  AudioContext: MockAudioContext,
  addEventListener() {},
  clearTimeout,
  requestAnimationFrame: (callback) => callback(),
  setTimeout
};
const WebSocketMock = { OPEN: 1 };

const sourcePath = path.join(__dirname, "..", "assets", "js", "xiaorui-realtime.js");
let sourceText = fs.readFileSync(sourcePath, "utf8");
sourceText = sourceText.replace(
  "  const root = document.querySelector(\"[data-xiaorui-widget]\");",
  "  globalThis.XiaoRuiRealtimeWidget = XiaoRuiRealtimeWidget;\n  const root = document.querySelector(\"[data-xiaorui-widget]\");"
);
const context = {
  Audio: MockAudio,
  URL,
  Uint8Array,
  Float32Array,
  DataView,
  Promise,
  WebSocket: WebSocketMock,
  atob: (value) => Buffer.from(value, "base64").toString("binary"),
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  document: documentMock,
  window: windowMock
};
context.globalThis = context;
vm.runInNewContext(sourceText, context, { filename: sourcePath });

const flush = () => new Promise((resolve) => setImmediate(resolve));
const message = (widget, event) => widget.handleMessage(JSON.stringify(event));
const pcmEvent = (generationId, index) => ({
  type: "server.audio.chunk",
  generation_id: generationId,
  audio_chunk_b64: Buffer.alloc(4800).toString("base64"),
  metadata: {
    generation_id: generationId,
    segment_id: `segment-${generationId}`,
    chunk_index: index,
    pcm_bytes_length: 4800,
    source_kind: "formal_answer"
  }
});

(async () => {
  const Widget = context.XiaoRuiRealtimeWidget;
  const widget = new Widget(root);
  const socket = { readyState: WebSocketMock.OPEN, sent: [], send(value) { this.sent.push(JSON.parse(value)); } };
  widget.socket = socket;
  widget.sessionReady = true;
  widget.setState("ready", "可以開始說話");

  widget.beginVoiceTurn();
  message(widget, { type: "server.asr.partial", text: "公司注册" });
  const firstUserBubble = widget.userBubble;
  assert.equal(firstUserBubble.querySelector("p").textContent, "公司注册");
  message(widget, { type: "server.asr.final", text: "公司註冊" });
  assert.equal(widget.userBubble, firstUserBubble, "final ASR must replace the provisional bubble");
  assert.equal(firstUserBubble.querySelector("p").textContent, "公司註冊");
  assert.equal(firstUserBubble.dataset.partial, "false");
  assert.equal(firstUserBubble.dataset.final, "true");

  message(widget, { type: "server.generation.started", generation_id: "turn-1" });
  message(widget, {
    type: "server.audio.segment.ready",
    metadata: {
      source_kind: "welcome",
      welcome_playback: true,
      welcome_audio: true,
      audio_url: "/api/realtime/audio/welcome.wav",
      mime_type: "audio/wav"
    }
  });
  assert.equal(mediaInstances.length, 1);
  assert.equal(mediaInstances[0].url, "https://xiaorui.skywingai.com/api/realtime/audio/welcome.wav");

  message(widget, pcmEvent("turn-1", 0));
  await flush();
  assert.equal(sources.length, 0, "formal PCM must wait while welcome is playing");
  mediaInstances[0].finish();
  await flush();
  await flush();
  assert.equal(sources.length, 1, "formal PCM must begin only after welcome ends");

  message(widget, { type: "server.voice.turn.completed", generation_id: "turn-1" });
  assert.equal(widget.turnActive, true, "server terminal must wait for active PCM");
  sources[0].finish(widget.audioContext);
  await flush();
  assert.equal(widget.turnActive, false);
  assert.equal(widget.state, "ready");
  assert.equal(widget.voiceButton.disabled, false, "turn 2 must be recordable after audio drains");

  const originalSocket = widget.socket;
  widget.beginVoiceTurn();
  assert.equal(widget.socket, originalSocket, "turn 2 must reuse the existing session socket");
  assert.equal(widget.welcomeExpected, false, "welcome must not replay in the same session");
  message(widget, { type: "server.generation.started", generation_id: "turn-2" });
  message(widget, pcmEvent("turn-2", 0));
  await flush();
  await flush();
  assert.equal(sources.length, 2);
  assert.equal(mediaInstances.length, 1, "welcome must play exactly once per session");
  message(widget, { type: "server.voice.turn.completed", generation_id: "turn-2" });
  sources[1].finish(widget.audioContext);
  await flush();
  assert.equal(widget.turnActive, false);
  assert.equal(widget.voiceButton.disabled, false);

  widget.shutdown();
  assert.equal(widget.sessionReady, false);
  assert.equal(widget.welcomePlayed, false, "closing resets welcome eligibility for a new session");
  assert.deepEqual(socket.sent.map((event) => event.type), ["client.session.close"]);

  console.log("xiaorui realtime contract harness: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
