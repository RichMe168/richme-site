(function attachRichMeXiaoRui(root) {
  "use strict";

  const PREVIEW_ENDPOINT = "wss://beta-xiaorui.skywingai.com/ws/realtime";
  const PRODUCTION_ENDPOINT = "wss://xiaorui.skywingai.com/ws/realtime";
  const PRODUCTION_HOSTS = new Set(["richme.pro", "www.richme.pro"]);
  const REQUIRED_SELECTORS = [
    "[data-xiaorui-launch]", "[data-xiaorui-panel]", "[data-xiaorui-close]",
    "[data-xiaorui-status-wrap]", "[data-xiaorui-status]", "[data-xiaorui-transcript]",
    "[data-xiaorui-hint]", "[data-xiaorui-voice]", "[data-xiaorui-voice-label]",
    "[data-xiaorui-retry]", "[data-xiaorui-welcome]"
  ];

  function resolveRealtimeEndpoint(locationLike) {
    const hostname = String(locationLike && locationLike.hostname || "").toLowerCase();
    return PRODUCTION_HOSTS.has(hostname) ? PRODUCTION_ENDPOINT : PREVIEW_ENDPOINT;
  }

  function assessVoiceEnvironment(windowRef) {
    const nav = windowRef.navigator || {};
    if (!windowRef.isSecureContext) return { available: false, code: "insecure_context" };
    if (!nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== "function") return { available: false, code: "microphone_api_unavailable" };
    if (typeof windowRef.MediaRecorder !== "function") return { available: false, code: "media_recorder_unavailable" };
    if (typeof windowRef.AudioContext !== "function" && typeof windowRef.webkitAudioContext !== "function") return { available: false, code: "audio_context_unavailable" };
    if (!windowRef.XiaoRuiRealtimeVerticalSlice || typeof windowRef.XiaoRuiRealtimeVerticalSlice.RebuildRealtimeApp !== "function") return { available: false, code: "canonical_runtime_unavailable" };
    return { available: true, code: "available" };
  }

  function createBubble(documentRef, transcript, label, kind) {
    const article = documentRef.createElement("article");
    article.className = `xiaorui-bubble xiaorui-bubble-${kind}`;
    article.dataset.canonicalTurn = "true";
    const name = documentRef.createElement("span");
    const paragraph = documentRef.createElement("p");
    name.textContent = label;
    article.append(name, paragraph);
    transcript.append(article);
    return article;
  }

  const CanonicalBase = root.XiaoRuiRealtimeVerticalSlice && root.XiaoRuiRealtimeVerticalSlice.RebuildRealtimeApp;
  class RichMeCanonicalApp extends (CanonicalBase || class {}) {
    constructor(options) {
      super(options);
      this.richMeEndpoint = options.endpoint;
    }

    wsUrl() {
      return this.richMeEndpoint;
    }
  }

  class RichMeRealtimeWidget {
    constructor(widgetRoot) {
      this.root = widgetRoot;
      this.document = widgetRoot && (widgetRoot.ownerDocument || root.document);
      this.launcher = this.find("[data-xiaorui-launch]");
      this.panel = this.find("[data-xiaorui-panel]");
      this.closeButton = this.find("[data-xiaorui-close]");
      this.statusWrap = this.find("[data-xiaorui-status-wrap]");
      this.statusText = this.find("[data-xiaorui-status]");
      this.transcript = this.find("[data-xiaorui-transcript]");
      this.hint = this.find("[data-xiaorui-hint]");
      this.voiceButton = this.find("[data-xiaorui-voice]");
      this.voiceLabel = this.find("[data-xiaorui-voice-label]");
      this.retryButton = this.find("[data-xiaorui-retry]");
      this.welcomeAudio = this.find("[data-xiaorui-welcome]");
      this.endpoint = resolveRealtimeEndpoint(root.location);
      this.app = null;
      this.started = false;
      this.starting = false;
      this.intentionalStop = false;
      this.eventsBound = false;
      this.initializationFailure = "";
      this.authoritativeSessionReady = false;
      this.sessionTraceFloor = 0;
      this.userBubbles = new Map();
      this.assistantBubbles = new Map();
      this.activeGenerationId = "";
      this.generationDisplayBaseline = "";
      this.generationDisplayText = "";
      this.lastDisplayText = "";
      this.lastProcessedGenerationId = "";
      this.lastProcessedFullDisplayText = "";
      this.lastDisconnectDiagnosticKey = "";

      this.initialize();
    }

    find(selector) {
      return this.root && typeof this.root.querySelector === "function" ? this.root.querySelector(selector) : null;
    }

    missingSelectors() {
      return REQUIRED_SELECTORS.filter((selector) => !this.find(selector));
    }

    initialize() {
      try {
        this.bindPanelEvents();
      } catch (error) {
        this.failInitialization("event_binding_failed", "語音視窗初始化失敗，請重新檢查。", true);
        if (root.console && typeof root.console.warn === "function") root.console.warn("XiaoRui widget initialization failed", error && error.name || "Error");
        return;
      }
      const missing = this.missingSelectors();
      if (missing.length) {
        this.failInitialization("control_dom_missing", "語音控制無法載入，請重新檢查。", true);
        return;
      }
      try {
        this.bindEvents();
        this.eventsBound = true;
        this.setUiState("checking", "正在檢查語音功能", "確認瀏覽器語音功能後即可開始對話。");
        this.refreshReadiness();
        this.renderControls();
      } catch (error) {
        this.failInitialization("event_binding_failed", "語音視窗初始化失敗，請重新檢查。", true);
        if (root.console && typeof root.console.warn === "function") root.console.warn("XiaoRui widget initialization failed", error && error.name || "Error");
      }
    }

    bindEvents() {
      this.voiceButton.addEventListener("click", () => {
        if (this.started || this.starting) this.stopConversation();
        else void this.startConversation();
      });
      this.retryButton.addEventListener("click", () => {
        if (this.initializationFailure) this.refreshReadiness();
        else void this.restartConversation();
      });
    }

    bindPanelEvents() {
      this.launcher.addEventListener("click", () => {
        if (this.panel.hidden) this.open();
        else this.close();
      });
      if (this.closeButton) this.closeButton.addEventListener("click", () => this.close());
      root.document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !this.panel.hidden) this.close();
      });
      root.addEventListener("pagehide", () => this.stopConversation());
    }

    open() {
      if (!this.panel || !this.launcher) {
        this.failInitialization("panel_dom_missing", "語音視窗無法載入，請重新檢查。", true);
        return;
      }
      this.panel.hidden = false;
      this.launcher.setAttribute("aria-expanded", "true");
      if (!this.started && !this.starting) this.refreshReadiness();
      this.renderControls();
      if (this.closeButton && typeof this.closeButton.focus === "function") this.closeButton.focus();
    }

    close() {
      this.stopConversation();
      if (this.panel) this.panel.hidden = true;
      if (this.launcher) {
        this.launcher.setAttribute("aria-expanded", "false");
        if (typeof this.launcher.focus === "function") this.launcher.focus();
      }
    }

    readinessMessage(code) {
      const messages = {
        insecure_context: ["頁面安全環境異常", "請使用 HTTPS 開啟本頁後重新檢查。"],
        microphone_api_unavailable: ["瀏覽器不支援麥克風", "此瀏覽器沒有可用的麥克風 API。"],
        media_recorder_unavailable: ["瀏覽器不支援語音錄製", "請使用支援 MediaRecorder 的最新瀏覽器。"],
        audio_context_unavailable: ["瀏覽器不支援音訊播放", "請使用支援 Web Audio 的最新瀏覽器。"],
        canonical_runtime_unavailable: ["語音功能載入失敗", "請重新檢查，或重新整理頁面後再試。"],
        control_dom_missing: ["語音控制無法載入", "請重新檢查，或重新整理頁面後再試。"],
        event_binding_failed: ["語音視窗初始化失敗", "請重新檢查，或重新整理頁面後再試。"],
        panel_dom_missing: ["語音視窗無法載入", "請重新檢查，或重新整理頁面後再試。"]
      };
      return messages[code] || ["語音功能暫時無法使用", "請重新檢查後再試。"];
    }

    refreshReadiness() {
      if (!this.eventsBound || this.initializationFailure) {
        const [label, hint] = this.readinessMessage(this.initializationFailure || "event_binding_failed");
        this.setUiState("error", label, hint);
        this.setControlsAvailable(false);
        return false;
      }
      this.setUiState("checking", "正在檢查語音功能", "確認瀏覽器語音功能後即可開始對話。");
      const environment = assessVoiceEnvironment(root);
      if (!environment.available) {
        const [label, hint] = this.readinessMessage(environment.code);
        this.setUiState("error", label, hint);
        this.setControlsAvailable(false);
        return false;
      }
      this.setControlsAvailable(true);
      this.setUiState("available", "可以開始語音對話", "按一下「開始語音對話」後才會要求麥克風權限。");
      return true;
    }

    setControlsAvailable(available) {
      if (this.voiceButton) this.voiceButton.disabled = !available || this.starting;
      if (this.retryButton) this.retryButton.hidden = available;
    }

    failInitialization(code, fallbackHint, ensureFallback) {
      this.initializationFailure = code;
      if (ensureFallback) this.ensureFallbackControls();
      const [label, hint] = this.readinessMessage(code);
      this.setUiState("error", label, fallbackHint || hint);
      this.setControlsAvailable(false);
    }

    ensureFallbackControls() {
      if (!this.panel || !this.document || typeof this.document.createElement !== "function") return;
      let controls = this.find(".xiaorui-controls");
      if (!controls) {
        controls = this.document.createElement("div");
        controls.className = "xiaorui-controls";
        controls.dataset.xiaoruiControlsFallback = "true";
        this.panel.append(controls);
      }
      if (!this.find("[data-xiaorui-fallback-control]")) {
        const button = this.document.createElement("button");
        button.type = "button";
        button.className = "xiaorui-voice-button";
        button.dataset.xiaoruiFallbackControl = "true";
        button.disabled = true;
        button.textContent = "語音功能暫時無法使用";
        controls.append(button);
      }
      if (!this.retryButton) {
        const retry = this.document.createElement("button");
        retry.type = "button";
        retry.className = "xiaorui-retry";
        retry.dataset.xiaoruiFallbackRetry = "true";
        retry.textContent = "重新檢查";
        retry.addEventListener("click", () => this.refreshReadiness());
        controls.append(retry);
      }
    }

    ensureApp() {
      if (this.app) return this.app;
      if (!CanonicalBase) throw new Error("CanonicalRuntimeUnavailable");
      this.app = new RichMeCanonicalApp({
        endpoint: this.endpoint,
        commit: "8bf9218a3f09d884d92e1ffc87417c80960ffa3e",
        welcomeAudio: this.welcomeAudio,
        render: (diagnostics, trace) => this.renderCanonicalState(diagnostics, trace)
      });
      return this.app;
    }

    async startConversation() {
      if (this.started || this.starting || !this.refreshReadiness()) return;
      this.starting = true;
      this.authoritativeSessionReady = false;
      this.retryButton.hidden = true;
      this.setUiState("connecting", "正在連線", "正在連線至語音服務。");
      this.renderControls();
      try {
        const app = this.ensureApp();
        this.sessionTraceFloor = app.eventSequence || 0;
        this.started = true;
        await app.start();
      } catch (error) {
        this.started = false;
        this.setUiState("error", "啟動失敗", this.startFailureMessage(error));
        this.retryButton.hidden = false;
      } finally {
        this.starting = false;
        this.renderControls();
      }
    }

    async restartConversation() {
      this.stopConversation();
      await this.startConversation();
    }

    stopConversation() {
      this.intentionalStop = true;
      try {
        if (this.app) {
          this.app.stop();
        }
        if (this.welcomeAudio && typeof this.welcomeAudio.pause === "function") this.welcomeAudio.pause();
      } finally {
        this.started = false;
        this.starting = false;
        this.authoritativeSessionReady = false;
        this.intentionalStop = false;
        if (this.retryButton) this.retryButton.hidden = true;
        this.refreshReadiness();
        this.renderControls();
      }
    }

    renderCanonicalState(diagnostics, trace) {
      if (this.initializationFailure || !assessVoiceEnvironment(root).available) {
        this.refreshReadiness();
        return;
      }
      const entries = Array.isArray(trace) ? trace : [];
      this.authoritativeSessionReady = this.authoritativeSessionReady || entries.some((entry) => (
        entry.event === "session_identity_accepted"
        && entry.runtime_streaming_provider === "xiaomi_streaming"
        && entry.success === true
        && Number(entry.sequence || 0) > this.sessionTraceFloor
      ));
      this.renderUserTranscript(diagnostics, entries);
      this.renderAssistantTranscript(diagnostics);
      this.renderStatus(diagnostics);
      this.renderControls();
    }

    renderUserTranscript(diagnostics, entries) {
      if (!this.transcript || diagnostics.asr_result !== "final" || !diagnostics.localized_transcript) return;
      const finalEvent = [...entries].reverse().find((entry) => entry.event === "asr_result_received" && entry.success === true);
      const turnId = String(finalEvent && finalEvent.utterance_id || diagnostics.active_turn_id || `turn-${this.userBubbles.size + 1}`);
      let bubble = this.userBubbles.get(turnId);
      if (!bubble) {
        bubble = createBubble(this.document, this.transcript, "訪客", "user");
        this.userBubbles.set(turnId, bubble);
      }
      bubble.dataset.final = "true";
      bubble.querySelector("p").textContent = diagnostics.localized_transcript;
      this.scrollTranscript();
    }

    renderAssistantTranscript(diagnostics) {
      if (!this.transcript) return;
      const generationId = String(diagnostics.active_playback_generation_id || this.app && this.app.generation && this.app.generation.generationId || "");
      const fullDisplayText = String(diagnostics.display_text || "");
      if (generationId === this.lastProcessedGenerationId && fullDisplayText === this.lastProcessedFullDisplayText) return;
      if (generationId && generationId !== this.activeGenerationId) {
        this.activeGenerationId = generationId;
        this.generationDisplayBaseline = this.lastDisplayText;
        this.generationDisplayText = "";
      }
      if (!generationId) {
        this.lastDisplayText = fullDisplayText;
        return;
      }
      const rollingUpdate = fullDisplayText.startsWith(this.lastDisplayText)
        && fullDisplayText.length >= this.lastDisplayText.length;
      this.generationDisplayText = rollingUpdate
        ? fullDisplayText.slice(this.generationDisplayBaseline.length)
        : fullDisplayText;
      this.lastDisplayText = fullDisplayText;
      this.lastProcessedGenerationId = generationId;
      this.lastProcessedFullDisplayText = fullDisplayText;
      const displayText = this.generationDisplayText;
      if (!displayText) return;
      let bubble = this.assistantBubbles.get(generationId);
      if (!bubble) {
        bubble = createBubble(this.document, this.transcript, "小睿", "assistant");
        this.assistantBubbles.set(generationId, bubble);
      }
      bubble.querySelector("p").textContent = displayText;
      this.scrollTranscript();
    }

    renderStatus(diagnostics) {
      const conversation = diagnostics.conversation_state || "";
      const playback = diagnostics.playback_state || "";
      const gateOpen = diagnostics.input_gate === "open";
      const microphoneFailureReason = String(diagnostics.microphone_failure_reason || "");
      if (diagnostics.websocket_connected === false && conversation === "disconnected") {
        const initiator = String(diagnostics.websocket_close_initiator || "");
        if (initiator === "user_stop" || this.intentionalStop) {
          if (!this.started && !this.starting) this.refreshReadiness();
          return;
        }
        this.logDisconnectDiagnostic(diagnostics);
        const [label, hint] = this.disconnectMessage(initiator);
        this.setUiState("error", label, hint);
        this.retryButton.hidden = false;
        return;
      }
      if (diagnostics.error_type || diagnostics.lifecycle_state === "FAILED") {
        const message = microphoneFailureReason === "microphone_api_unavailable"
          ? "瀏覽器不支援麥克風 API。"
          : "語音服務連線失敗，請重新連線。";
        this.setUiState("error", "語音服務連線失敗", message);
        this.retryButton.hidden = false;
        return;
      }
      if (microphoneFailureReason) {
        const [label, hint] = this.microphoneFailureMessage(microphoneFailureReason);
        this.setUiState("error", label, hint);
        this.retryButton.hidden = false;
        return;
      }
      if (!this.authoritativeSessionReady) {
        this.setUiState("connecting", "正在連線", "等待語音工作階段建立。");
        return;
      }
      if (playback === "playing" || playback === "buffering" || conversation === "assistant_playing") {
        this.setUiState("playing", "小睿回覆中", "請等待語音播放完成後再說話。");
        return;
      }
      if (conversation === "understanding" || diagnostics.asr_result === "started") {
        this.setUiState("processing", "小睿理解中", "正在整理您的問題。");
        return;
      }
      if (conversation === "speech_started") {
        this.setUiState("recording", "正在聆聽", "說完後會自動送出。");
        return;
      }
      if (gateOpen && diagnostics.listening_active) {
        this.setUiState("ready", "準備就緒", "小睿正在聆聽，您可以開始說話。");
        return;
      }
      this.setUiState("connecting", "正在準備語音", "正在等待歡迎語音完成。");
    }

    microphoneFailureMessage(reason) {
      const messages = {
        microphone_permission_denied: ["麥克風權限遭拒", "請在瀏覽器網站設定允許麥克風後，按「重新連線」。"],
        getUserMedia_rejected: ["無法啟用麥克風", "瀏覽器未能取得麥克風。請確認輸入裝置後重新連線。"],
        audio_context_unavailable_for_microphone: ["無法啟用音訊", "瀏覽器無法建立語音所需的音訊環境，請重新連線。"],
        web_audio_capture_failed: ["無法建立語音擷取", "麥克風已允許但音訊擷取未完成，請重新連線。"],
        microphone_stream_not_live: ["找不到可用的麥克風", "請確認麥克風已連接且未被其他程式占用，然後重新連線。"],
        microphone_not_ready_after_welcome: ["麥克風尚未完成初始化", "小睿已完成歡迎語音，但麥克風尚未就緒。請重新連線。"],
        microphone_api_unavailable: ["瀏覽器不支援麥克風", "此瀏覽器沒有可用的麥克風 API。"]
      };
      return messages[reason] || ["麥克風初始化失敗", "語音輸入尚未就緒，請重新連線。"];
    }

    disconnectMessage(initiator) {
      if (initiator === "backend_session_closed") return ["語音工作階段已結束", "語音服務已正常關閉本次工作階段，請按「重新連線」。"];
      return ["語音連線已中斷", "語音服務連線意外中斷，請按「重新連線」。"];
    }

    logDisconnectDiagnostic(diagnostics) {
      const detail = {
        websocket_close_initiator: String(diagnostics.websocket_close_initiator || "browser_or_backend"),
        websocket_close_code: String(diagnostics.websocket_close_code || ""),
        websocket_close_reason: String(diagnostics.websocket_close_reason || ""),
        last_server_event_before_close: String(diagnostics.last_server_event_before_close || ""),
        last_client_event_before_close: String(diagnostics.last_client_event_before_close || ""),
        current_session_id: String(diagnostics.current_session_id || ""),
        conversation_state: String(diagnostics.conversation_state || ""),
        input_gate: String(diagnostics.input_gate || ""),
        listening_active: Boolean(diagnostics.listening_active)
      };
      const key = JSON.stringify(detail);
      if (key === this.lastDisconnectDiagnosticKey) return;
      this.lastDisconnectDiagnosticKey = key;
      if (root.console && typeof root.console.warn === "function") root.console.warn("XiaoRui realtime session disconnected", detail);
    }

    setUiState(state, label, hint) {
      if (this.statusWrap) this.statusWrap.dataset.state = state;
      if (this.statusText) this.statusText.textContent = label;
      if (this.hint) this.hint.textContent = hint;
    }

    renderControls() {
      if (!this.voiceButton || !this.voiceLabel) return;
      this.voiceButton.disabled = this.starting || Boolean(this.initializationFailure) || !assessVoiceEnvironment(root).available;
      this.voiceButton.dataset.recording = "false";
      this.voiceLabel.textContent = this.started || this.starting ? "結束語音對話" : "開始語音對話";
    }

    scrollTranscript() {
      if (!this.transcript || typeof root.requestAnimationFrame !== "function") return;
      root.requestAnimationFrame(() => { this.transcript.scrollTop = this.transcript.scrollHeight; });
    }

    startFailureMessage(error) {
      if (error && (error.name === "NotAllowedError" || error.name === "SecurityError")) return "麥克風權限遭拒，請在瀏覽器網站設定允許麥克風後重新連線。";
      if (error && (error.name === "NotFoundError" || error.name === "DevicesNotFoundError")) return "找不到可用的麥克風，請連接或啟用輸入裝置後重新連線。";
      return "無法啟動語音服務，請重新連線後再試。";
    }
  }

  const api = Object.freeze({
    PREVIEW_ENDPOINT,
    PRODUCTION_ENDPOINT,
    RichMeCanonicalApp,
    RichMeRealtimeWidget,
    assessVoiceEnvironment,
    resolveRealtimeEndpoint
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RichMeXiaoRui = api;

  if (root.document) {
    const widgetRoot = root.document.querySelector("[data-xiaorui-widget]");
    if (widgetRoot) new RichMeRealtimeWidget(widgetRoot);
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
