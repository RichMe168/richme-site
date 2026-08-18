"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const canonicalDir = path.join(repoRoot, "assets", "js", "xiaorui-canonical");

const canonicalHashes = {
  "audio_format_resolver.js": "47eb4423c44d830f151aa6ebbfef9a6315944f2bc4bdf43e1e5d1e1cd5e84fc2",
  "device_audio_environment.js": "83d208f135441bf2b842c5a3e9123bf60fde5a5064fd6193fdad46c592cbe2b8",
  "playback_adapter.js": "3d36a5a2d3827f47a2cf3e189b1e7803c630aae992befb3f91fd82171d4892f7",
  "realtime_vertical_slice.js": "f8eb9beb1a6fa8ca35fab506ca1b0400542f836844b09486c7170f3dc7c9ff2d",
  "recorder_adapter.js": "f9b096b84d8cf543d458abf5c828e79f35bebfb9c10abbbb50478f6e495e1cd0"
};

for (const [fileName, expectedHash] of Object.entries(canonicalHashes)) {
  const content = fs.readFileSync(path.join(canonicalDir, fileName));
  const gitNormalizedContent = content.toString("utf8").replace(/\r\n/g, "\n");
  assert.equal(crypto.createHash("sha256").update(gitNormalizedContent).digest("hex"), expectedHash, `${fileName} must remain byte-identical to B after Git line-ending normalization`);
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
Object.defineProperty(global, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia() { return Promise.resolve(liveStream()); } } } });
global.MediaRecorder = class { static isTypeSupported() { return true; } };
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
widget.open();
assert.notEqual(selectors.get("[data-xiaorui-status]").textContent, "準備就緒", "opening before session initialization must not claim ready");
assert.equal(selectors.get("[data-xiaorui-voice]").disabled, false, "a supported browser must retain an operable voice control");
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

for (const reason of [
  "microphone_permission_denied",
  "getUserMedia_rejected",
  "audio_context_unavailable_for_microphone",
  "web_audio_capture_failed",
  "microphone_stream_not_live",
  "microphone_not_ready_after_welcome"
]) {
  widget.renderCanonicalState({
    welcome_completed: true,
    microphone_ready: false,
    microphone_failure_reason: reason,
    input_gate: "open",
    listening_active: false,
    conversation_state: "listening",
    playback_state: "idle",
    lifecycle_state: "ACTIVE"
  }, [{ event: "session_identity_accepted", success: true, sequence: 1, runtime_streaming_provider: "xiaomi_streaming" }]);
  assert.equal(selectors.get("[data-xiaorui-status-wrap]").dataset.state, "error", `${reason} must be visible even when canonical lifecycle remains ACTIVE`);
  assert.notEqual(selectors.get("[data-xiaorui-status]").textContent, "正在準備語音", `${reason} must not remain in the preparing state`);
  assert.equal(selectors.get("[data-xiaorui-retry]").hidden, false, `${reason} must retain reconnect control`);
}

widget.renderCanonicalState({
  welcome_completed: true,
  microphone_ready: true,
  microphone_failure_reason: "",
  input_gate: "open",
  listening_active: true,
  conversation_state: "listening",
  playback_state: "idle",
  lifecycle_state: "ACTIVE"
}, [{ event: "session_identity_accepted", success: true, sequence: 1, runtime_streaming_provider: "xiaomi_streaming" }]);
assert.equal(selectors.get("[data-xiaorui-status-wrap]").dataset.state, "ready", "completed welcome with a live microphone must become ready");
assert.equal(selectors.get("[data-xiaorui-status]").textContent, "準備就緒");

const missingSelectors = new Map(selectors);
missingSelectors.delete("[data-xiaorui-voice]");
missingSelectors.delete("[data-xiaorui-voice-label]");
const missingDomWidget = new adapter.RichMeRealtimeWidget({ querySelector: (selector) => missingSelectors.get(selector) || null });
assert.equal(missingSelectors.get("[data-xiaorui-status-wrap]").dataset.state, "error", "missing controls must present a visible error state");
assert.ok(missingSelectors.get("[data-xiaorui-panel]").children.some((child) => child.className === "xiaorui-controls"), "missing controls must mount a visible fallback control area");

const unsupportedSelectors = new Map();
for (const selector of [
  "[data-xiaorui-launch]", "[data-xiaorui-panel]", "[data-xiaorui-close]",
  "[data-xiaorui-status-wrap]", "[data-xiaorui-status]", "[data-xiaorui-transcript]",
  "[data-xiaorui-hint]", "[data-xiaorui-voice]", "[data-xiaorui-voice-label]",
  "[data-xiaorui-retry]", "[data-xiaorui-welcome]"
]) unsupportedSelectors.set(selector, new MockElement());
const supportedNavigator = global.navigator;
Object.defineProperty(global, "navigator", { configurable: true, value: {} });
const unsupportedWidget = new adapter.RichMeRealtimeWidget({ querySelector: (selector) => unsupportedSelectors.get(selector) || null });
unsupportedWidget.open();
assert.equal(unsupportedSelectors.get("[data-xiaorui-status-wrap]").dataset.state, "error", "unsupported voice APIs must not claim ready");
assert.equal(unsupportedSelectors.get("[data-xiaorui-voice]").disabled, true, "unsupported voice APIs must retain a visible disabled control");
Object.defineProperty(global, "navigator", { configurable: true, value: supportedNavigator });

const headers = fs.readFileSync(path.join(repoRoot, "_headers"), "utf8");
assert.match(headers, /Permissions-Policy: camera=\(\), geolocation=\(\), microphone=\(self\)/);
assert.match(headers, /wss:\/\/beta-xiaorui\.skywingai\.com/);
assert.match(headers, /wss:\/\/xiaorui\.skywingai\.com/);
assert.doesNotMatch(headers, /connect-src[^\n]*\*/);
assert.doesNotMatch(headers, /media-src[^\n]*\*/);

const adapterSource = fs.readFileSync(path.join(repoRoot, "assets", "js", "xiaorui-realtime.js"), "utf8");
assert.doesNotMatch(adapterSource, /new WebSocket\(/, "UI adapter must not own the WebSocket state machine");
assert.doesNotMatch(adapterSource, /pcm16le|server\.voice\.turn\.completed|server\.audio\.chunk/, "UI adapter must not reimplement canonical PCM or terminal handling");

const indexHtml = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
const siteCss = fs.readFileSync(path.join(repoRoot, "assets", "css", "site.css"), "utf8");
assert.match(siteCss, /\.xiaorui-conversation\s*\{[^}]*overflow:\s*hidden[^}]*flex:\s*1 1 auto/s, "conversation layout must constrain scrolling content instead of clipping controls");
assert.match(siteCss, /\.xiaorui-controls\s*\{\s*flex:\s*0 0 auto;/, "controls must not shrink out of the panel");
const widgetAssetVersion = "xiaorui-controls-v1";
for (const assetPath of [
  "assets/css/site.css",
  "assets/js/xiaorui-canonical/audio_format_resolver.js",
  "assets/js/xiaorui-canonical/device_audio_environment.js",
  "assets/js/xiaorui-canonical/recorder_adapter.js",
  "assets/js/xiaorui-canonical/playback_adapter.js",
  "assets/js/xiaorui-canonical/realtime_vertical_slice.js",
  "assets/js/xiaorui-realtime.js"
]) assert.ok(indexHtml.includes(`${assetPath}?v=${widgetAssetVersion}`), `${assetPath} must use the shared widget asset version`);

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
