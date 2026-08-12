"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const canonicalDir = path.join(repoRoot, "assets", "js", "xiaorui-canonical");

const canonicalHashes = {
  "audio_format_resolver.js": "51b12bd01c08009ef304631873dbd1cadbd8150b96cbf366b21bad2199a6caf9",
  "device_audio_environment.js": "1dd4559ad42567a62549e9d3d0502549e2732ea1ef8a6a45e38aa3f947baaf13",
  "playback_adapter.js": "57ec6a6deae57e9ed01d9058a347aaa2449858175d4dfd3a3b0b4e26cf576e31",
  "realtime_vertical_slice.js": "abdf899eea9ebbab134541afca2249441d6e00df579f6fc470ea6bfb00159245",
  "recorder_adapter.js": "bebd491e82c300bb5ee9e123b87f57192d5ddec7d1041fcc37931ca125b98117"
};

for (const [fileName, expectedHash] of Object.entries(canonicalHashes)) {
  const content = fs.readFileSync(path.join(canonicalDir, fileName));
  assert.equal(crypto.createHash("sha256").update(content).digest("hex"), expectedHash, `${fileName} must remain byte-identical to B`);
}
const welcomeContent = fs.readFileSync(path.join(repoRoot, "static", "audio", "bingtang_session_welcome.mp3"));
assert.equal(
  crypto.createHash("sha256").update(welcomeContent).digest("hex"),
  "8b80c33e9dd249ea2258735f393121d6e7f1f65b4a695229fe26695508adcb4a",
  "welcome asset must remain byte-identical to B"
);

function eventTarget() {
  const listeners = {};
  return {
    addEventListener(type, listener) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(listener);
    },
    emit(type, event) {
      for (const listener of listeners[type] || []) listener(event || { type });
    }
  };
}

global.atob = (value) => Buffer.from(value, "base64").toString("binary");
global.performance = { now: () => 1000 };
global.location = { protocol: "https:", host: "preview.pages.dev", hostname: "preview.pages.dev", href: "https://preview.pages.dev/" };
global.requestAnimationFrame = () => {};
global.addEventListener = () => {};
global.document = { addEventListener() {}, querySelector: () => null };
global.isSecureContext = true;

require(path.join(canonicalDir, "audio_format_resolver.js"));
require(path.join(canonicalDir, "device_audio_environment.js"));
require(path.join(canonicalDir, "recorder_adapter.js"));
require(path.join(canonicalDir, "playback_adapter.js"));
const canonical = require(path.join(canonicalDir, "realtime_vertical_slice.js"));

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = "running";
    this.destination = {};
    this.sources = [];
  }

  createBuffer(_channels, length, sampleRate) {
    return { duration: length / sampleRate, copyToChannel() {} };
  }

  createBufferSource() {
    const source = {
      buffer: null,
      onended: null,
      connect() {},
      start(startAt) { this.startAt = startAt; },
      stop() { if (this.onended) this.onended(); }
    };
    this.sources.push(source);
    return source;
  }

  createAnalyser() { return { fftSize: 0, getByteTimeDomainData() {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  resume() { this.state = "running"; return Promise.resolve(); }
}
global.AudioContext = FakeAudioContext;

const socketInstances = [];
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    this.closed = false;
    this.target = eventTarget();
    socketInstances.push(this);
  }
  addEventListener(type, listener) { this.target.addEventListener(type, listener); }
  emit(type, event) { this.target.emit(type, event); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; this.readyState = 3; }
}
FakeWebSocket.OPEN = 1;
global.WebSocket = FakeWebSocket;

function buildAudio() {
  const target = eventTarget();
  return {
    id: "welcomeAudio",
    src: "",
    currentSrc: "",
    paused: true,
    currentTime: 0,
    duration: 1.5,
    playCalls: 0,
    addEventListener: target.addEventListener,
    emit(type) {
      if (type === "playing") this.paused = false;
      if (type === "ended") { this.paused = true; this.currentTime = this.duration; }
      target.emit(type, { type });
    },
    play() { this.playCalls += 1; this.currentSrc = this.src; return Promise.resolve(); },
    pause() { this.paused = true; }
  };
}

function liveStream() {
  const track = { kind: "audio", enabled: true, muted: false, readyState: "live", stopped: false, stop() { this.stopped = true; } };
  return { active: true, track, getTracks() { return [track]; } };
}

(async () => {
const renders = [];
const welcomeAudio = buildAudio();
const app = new canonical.RebuildRealtimeApp({
  welcomeAudio,
  render(diagnostics, trace) { renders.push({ diagnostics: { ...diagnostics }, trace: [...trace] }); }
});
const audioContext = new FakeAudioContext();
const stream = liveStream();
app.audioContext = audioContext;
app.playback.setAudioContext(audioContext);
app.stream = stream;
app.microphoneReady = true;
app.vadRunning = true;
app.vadAnalyser = audioContext.createAnalyser();

app.welcome.start();
assert.equal(welcomeAudio.playCalls, 1, "welcome must start exactly once for this session startup");
assert.equal(app.inputGate.value, "assistant_playing", "welcome must close input before formal turns");
welcomeAudio.emit("playing");
welcomeAudio.emit("ended");
assert.equal(app.inputGate.value, "open", "welcome completion must reopen input");
assert.equal(app.state.listening_active, true);

function pcmEvent(generationId, segmentId, chunkIndex) {
  return {
    type: "server.audio.chunk",
    generation_id: generationId,
    audio_chunk_b64: Buffer.alloc(4800).toString("base64"),
    metadata: {
      generation_id: generationId,
      segment_id: segmentId,
      segment_index: 0,
      chunk_index: chunkIndex,
      pcm_bytes_length: 4800,
      sample_rate: 24000,
      source_kind: "formal_answer"
    }
  };
}

function completePcmTurn(generationId, utteranceId) {
  const segmentId = `segment-${generationId}`;
  app.generation.start(generationId, utteranceId);
  app.playback.scheduleChunk(pcmEvent(generationId, segmentId, 0));
  app.generation.segmentCompleted({ metadata: { generation_id: generationId, segment_id: segmentId, segment_index: 0 } });
  app.handleServerEvent({ type: "server.voice.turn.completed", metadata: { generation_id: generationId } });
  assert.equal(app.generation.generationCompleted, false, "server terminal must wait for PCM drain");
  assert.equal(app.inputGate.value, "closed");
  const source = audioContext.sources.at(-1);
  audioContext.currentTime = app.playback.scheduledAudioEndTimeForGeneration(generationId) + 0.01;
  source.onended();
  assert.equal(app.generation.generationCompleted, true);
  assert.equal(app.inputGate.value, "open");
  assert.equal(app.state.listening_active, true);
}

const sameSessionSocket = new FakeWebSocket("wss://beta-xiaorui.skywingai.com/ws/realtime");
app.socket = sameSessionSocket;
app.sessionReady = true;
app.currentSessionId = "xiaomi-session-1";
completePcmTurn("generation-1", "utterance-1");
assert.equal(app.socket, sameSessionSocket);
completePcmTurn("generation-2", "utterance-2");
assert.equal(app.socket, sameSessionSocket, "turn 2 must reuse the same session socket");
assert.equal(welcomeAudio.playCalls, 1, "welcome must not replay for turn 2");
assert.equal(app.sessionPcmReceivedTotal, 2);
assert.equal(app.sessionPcmScheduledTotal, 2);
assert.equal(app.sessionPcmPlayedTotal, 2);

app.handleServerEvent({ type: "server.asr.final", text: "公司註冊", metadata: { utterance_id: "utterance-2" } });
assert.equal(app.diagnostics.localized_transcript, "公司註冊", "server.asr.final must remain authoritative");

global.FileReader = class {
  readAsDataURL() { this.result = "data:audio/mp4;base64,YWJj"; if (this.onload) this.onload(); }
};
const endpointApp = new canonical.RebuildRealtimeApp({ welcomeAudio: buildAudio(), render() {} });
endpointApp.wsUrl = () => "wss://beta-xiaorui.skywingai.com/ws/realtime";
const firstSocket = endpointApp.connectWebSocket();
firstSocket.emit("open");
endpointApp.sessionReady = true;
await endpointApp.sendVoiceBlob(new Blob(["abc"], { type: "audio/mp4" }), "utterance-send", 1, "audio/mp4", null);
endpointApp.stop();
assert.deepEqual(firstSocket.sent.map((event) => event.type), [
  "client.session.start",
  "client.voice.turn.start",
  "client.session.close"
], "outbound events must be canonical and allowlisted");
assert.equal(firstSocket.closed, true);

const initialEvent = {
  type: "server.session.created",
  session: { session_id: "initial-mock", runtime_streaming_provider: "mock_streaming" },
  metadata: { session_id: "initial-mock", runtime_streaming_provider: "mock_streaming" }
};
const authoritativeEvent = {
  type: "server.session.created",
  session: { session_id: "xiaomi-authoritative", runtime_streaming_provider: "xiaomi_streaming" },
  metadata: { session_id: "xiaomi-authoritative", runtime_streaming_provider: "xiaomi_streaming" }
};
endpointApp.handleServerEvent(initialEvent);
endpointApp.handleServerEvent(authoritativeEvent);
assert.equal(endpointApp.currentSessionId, "xiaomi-authoritative");
assert.equal(endpointApp.diagnostics.provider, "xiaomi");

const originalSocketId = endpointApp.socketInstanceId;
const reopenedSocket = endpointApp.connectWebSocket();
assert.notEqual(endpointApp.socketInstanceId, originalSocketId, "reopen must establish a new socket identity");
assert.notEqual(reopenedSocket, firstSocket);

class MockElement {
  constructor() {
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.children = [];
    this.attributes = {};
  }
  addEventListener() {}
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
  append(...children) { this.children.push(...children); }
  querySelector(selector) { return selector === "p" ? this.children.find((child) => child.tagName === "p") || null : null; }
}
function makeDocumentElement(tagName) {
  const element = new MockElement();
  element.tagName = tagName;
  return element;
}
const adapterDocument = {
  addEventListener() {},
  querySelector: () => null,
  createElement: makeDocumentElement
};
global.document = adapterDocument;
global.location = { hostname: "feature-branch.richme-site.pages.dev" };
const adapter = require(path.join(repoRoot, "assets", "js", "xiaorui-realtime.js"));
assert.equal(adapter.resolveRealtimeEndpoint({ hostname: "feature-branch.richme-site.pages.dev" }), adapter.PREVIEW_ENDPOINT);
assert.equal(adapter.resolveRealtimeEndpoint({ hostname: "localhost" }), adapter.PREVIEW_ENDPOINT);
assert.equal(adapter.resolveRealtimeEndpoint({ hostname: "richme.pro" }), adapter.PRODUCTION_ENDPOINT);
assert.equal(adapter.resolveRealtimeEndpoint({ hostname: "www.richme.pro" }), adapter.PRODUCTION_ENDPOINT);

const selectors = new Map();
for (const selector of [
  "[data-xiaorui-launch]", "[data-xiaorui-panel]", "[data-xiaorui-close]",
  "[data-xiaorui-status-wrap]", "[data-xiaorui-status]", "[data-xiaorui-transcript]",
  "[data-xiaorui-hint]", "[data-xiaorui-voice]", "[data-xiaorui-voice-label]",
  "[data-xiaorui-retry]", "[data-xiaorui-welcome]"
]) selectors.set(selector, new MockElement());
const widgetRoot = { querySelector: (selector) => selectors.get(selector) || null };
const widget = new adapter.RichMeRealtimeWidget(widgetRoot);
widget.renderCanonicalState({
  asr_result: "final",
  localized_transcript: "公司註冊",
  active_turn_id: "utterance-ui",
  active_playback_generation_id: "",
  display_text: "",
  input_gate: "open",
  listening_active: true,
  conversation_state: "listening",
  playback_state: "idle",
  lifecycle_state: "ACTIVE"
}, [{ event: "asr_result_received", success: true, utterance_id: "utterance-ui" }]);
assert.equal(selectors.get("[data-xiaorui-status-wrap]").dataset.state, "connecting", "UI must not declare READY before authoritative Xiaomi session");
widget.renderCanonicalState({
  asr_result: "final",
  localized_transcript: "公司註冊",
  active_turn_id: "utterance-ui",
  active_playback_generation_id: "",
  display_text: "",
  input_gate: "open",
  listening_active: true,
  conversation_state: "listening",
  playback_state: "idle",
  lifecycle_state: "ACTIVE"
}, [
  { event: "asr_result_received", success: true, utterance_id: "utterance-ui" },
  { event: "session_identity_accepted", success: true, sequence: 1, runtime_streaming_provider: "xiaomi_streaming" }
]);
assert.equal(selectors.get("[data-xiaorui-status-wrap]").dataset.state, "ready");
const userBubble = widget.userBubbles.get("utterance-ui");
assert.equal(userBubble.querySelector("p").textContent, "公司註冊");
assert.equal(userBubble.dataset.final, "true");

const headers = fs.readFileSync(path.join(repoRoot, "_headers"), "utf8");
assert.match(headers, /Permissions-Policy: camera=\(\), geolocation=\(\), microphone=\(self\)/);
assert.match(headers, /wss:\/\/beta-xiaorui\.skywingai\.com/);
assert.match(headers, /wss:\/\/xiaorui\.skywingai\.com/);
assert.doesNotMatch(headers, /connect-src[^\n]*\*/);
assert.doesNotMatch(headers, /media-src[^\n]*\*/);

const adapterSource = fs.readFileSync(path.join(repoRoot, "assets", "js", "xiaorui-realtime.js"), "utf8");
assert.doesNotMatch(adapterSource, /new WebSocket\(/, "UI adapter must not own the WebSocket state machine");
assert.doesNotMatch(adapterSource, /pcm16le|server\.voice\.turn\.completed|server\.audio\.chunk/, "UI adapter must not reimplement canonical PCM or terminal handling");

const staticPaths = [
  "/",
  "/assets/js/xiaorui-realtime.js",
  "/assets/js/xiaorui-canonical/realtime_vertical_slice.js",
  "/assets/css/site.css",
  "/static/audio/bingtang_session_welcome.mp3",
  "/_headers"
];
const staticServer = http.createServer((request, response) => {
  const relativePath = request.url === "/" ? "index.html" : request.url.slice(1);
  fs.readFile(path.join(repoRoot, relativePath), (error, content) => {
    response.statusCode = error ? 404 : 200;
    response.end(error ? "" : content);
  });
});
await new Promise((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
try {
  const address = staticServer.address();
  for (const staticPath of staticPaths) {
    const result = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: address.port, path: staticPath }, (response) => {
        let byteLength = 0;
        response.on("data", (chunk) => { byteLength += chunk.length; });
        response.on("end", () => resolve({ statusCode: response.statusCode, byteLength }));
      }).on("error", reject);
    });
    assert.equal(result.statusCode, 200, `${staticPath} must return HTTP 200`);
    assert.ok(result.byteLength > 0, `${staticPath} must not be empty`);
  }
} finally {
  await new Promise((resolve) => staticServer.close(resolve));
}

console.log("xiaorui canonical RichMe contract harness: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
