(function attachRichMeXiaoRui(root) {
  "use strict";

  const PREVIEW_ENDPOINT = "wss://beta-xiaorui.skywingai.com/ws/realtime";
  const PRODUCTION_ENDPOINT = "wss://xiaorui.skywingai.com/ws/realtime";
  const PRODUCTION_HOSTS = new Set(["richme.pro", "www.richme.pro"]);

  function resolveRealtimeEndpoint(locationLike) {
    const hostname = String(locationLike && locationLike.hostname || "").toLowerCase();
    return PRODUCTION_HOSTS.has(hostname) ? PRODUCTION_ENDPOINT : PREVIEW_ENDPOINT;
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

  class RichMeCanonicalApp extends root.XiaoRuiRealtimeVerticalSlice.RebuildRealtimeApp {
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
      this.launcher = widgetRoot.querySelector("[data-xiaorui-launch]");
      this.panel = widgetRoot.querySelector("[data-xiaorui-panel]");
      this.closeButton = widgetRoot.querySelector("[data-xiaorui-close]");
      this.statusWrap = widgetRoot.querySelector("[data-xiaorui-status-wrap]");
      this.statusText = widgetRoot.querySelector("[data-xiaorui-status]");
      this.transcript = widgetRoot.querySelector("[data-xiaorui-transcript]");
      this.hint = widgetRoot.querySelector("[data-xiaorui-hint]");
      this.voiceButton = widgetRoot.querySelector("[data-xiaorui-voice]");
      this.voiceLabel = widgetRoot.querySelector("[data-xiaorui-voice-label]");
      this.retryButton = widgetRoot.querySelector("[data-xiaorui-retry]");
      this.welcomeAudio = widgetRoot.querySelector("[data-xiaorui-welcome]");
      this.endpoint = resolveRealtimeEndpoint(root.location);
      this.app = null;
      this.started = false;
      this.starting = false;
      this.authoritativeSessionReady = false;
      this.sessionTraceFloor = 0;
      this.userBubbles = new Map();
      this.assistantBubbles = new Map();
      this.activeGenerationId = "";
      this.generationDisplayOffset = 0;
      this.lastDisplayText = "";

      if (!this.launcher || !this.panel || !this.closeButton || !this.voiceButton || !this.welcomeAudio) return;
      this.bindEvents();
      this.setUiState("offline", "尚未啟動", "開啟面板後，按一下按鈕開始語音對話。");
      this.renderControls();
    }

    bindEvents() {
      this.launcher.addEventListener("click", () => {
        if (this.panel.hidden) this.open();
        else this.close();
      });
      this.closeButton.addEventListener("click", () => this.close());
      this.voiceButton.addEventListener("click", () => {
        if (this.started || this.starting) this.stopConversation();
        else void this.startConversation();
      });
      this.retryButton.addEventListener("click", () => void this.restartConversation());
      root.document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !this.panel.hidden) this.close();
      });
      root.addEventListener("pagehide", () => this.stopConversation());
    }

    open() {
      this.panel.hidden = false;
      this.launcher.setAttribute("aria-expanded", "true");
      if (!this.started && !this.starting) {
        this.setUiState("offline", "準備就緒", "按一下「開始語音對話」並允許麥克風權限。");
      }
      this.renderControls();
      this.closeButton.focus();
    }

    close() {
      this.stopConversation();
      this.panel.hidden = true;
      this.launcher.setAttribute("aria-expanded", "false");
      this.launcher.focus();
    }

    ensureApp() {
      if (this.app) return this.app;
      this.app = new RichMeCanonicalApp({
        endpoint: this.endpoint,
        commit: "32ffb2feae3b5d3fceeb1fb0e722555350388f00",
        welcomeAudio: this.welcomeAudio,
        render: (diagnostics, trace) => this.renderCanonicalState(diagnostics, trace)
      });
      return this.app;
    }

    async startConversation() {
      if (this.started || this.starting) return;
      this.starting = true;
      this.authoritativeSessionReady = false;
      this.retryButton.hidden = true;
      this.setUiState("connecting", "正在啟動", "正在建立 Beta XiaoRui 安全語音連線…");
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
      if (this.app) {
        if (this.app.playback && typeof this.app.playback.clearForLifecycle === "function") {
          this.app.playback.clearForLifecycle("richme_widget_closed", "richme_ui");
        }
        this.app.stop();
      }
      if (typeof this.welcomeAudio.pause === "function") this.welcomeAudio.pause();
      this.started = false;
      this.starting = false;
      this.authoritativeSessionReady = false;
      this.retryButton.hidden = true;
      this.setUiState("offline", "對話已結束", "再次開始時會建立新的有效語音工作階段。");
      this.renderControls();
    }

    renderCanonicalState(diagnostics, trace) {
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
      if (diagnostics.asr_result !== "final" || !diagnostics.localized_transcript) return;
      const finalEvent = [...entries].reverse().find((entry) => entry.event === "asr_result_received" && entry.success === true);
      const turnId = String(finalEvent && finalEvent.utterance_id || diagnostics.active_turn_id || `turn-${this.userBubbles.size + 1}`);
      let bubble = this.userBubbles.get(turnId);
      if (!bubble) {
        bubble = createBubble(root.document, this.transcript, "您", "user");
        this.userBubbles.set(turnId, bubble);
      }
      bubble.dataset.final = "true";
      bubble.querySelector("p").textContent = diagnostics.localized_transcript;
      this.scrollTranscript();
    }

    renderAssistantTranscript(diagnostics) {
      const generationId = String(diagnostics.active_playback_generation_id || this.app && this.app.generation && this.app.generation.generationId || "");
      const fullDisplayText = String(diagnostics.display_text || "");
      if (generationId && generationId !== this.activeGenerationId) {
        this.activeGenerationId = generationId;
        this.generationDisplayOffset = this.lastDisplayText.length;
      }
      this.lastDisplayText = fullDisplayText;
      if (!generationId) return;

      let displayText = fullDisplayText.slice(this.generationDisplayOffset);
      if (!displayText && fullDisplayText && this.generationDisplayOffset >= fullDisplayText.length) displayText = fullDisplayText;
      if (!displayText) return;
      let bubble = this.assistantBubbles.get(generationId);
      if (!bubble) {
        bubble = createBubble(root.document, this.transcript, "小睿", "assistant");
        this.assistantBubbles.set(generationId, bubble);
      }
      bubble.querySelector("p").textContent = displayText;
      this.scrollTranscript();
    }

    renderStatus(diagnostics) {
      const conversation = diagnostics.conversation_state || "";
      const playback = diagnostics.playback_state || "";
      const gateOpen = diagnostics.input_gate === "open";
      if (diagnostics.error_type || diagnostics.lifecycle_state === "FAILED") {
        this.setUiState("error", "語音服務暫時無法使用", "請重新連線；若持續失敗，請稍後再試。");
        this.retryButton.hidden = false;
        return;
      }
      if (!this.authoritativeSessionReady) {
        this.setUiState("connecting", "正在連線", "等待 authoritative xiaomi_streaming 工作階段…");
        return;
      }
      if (playback === "playing" || playback === "buffering" || conversation === "assistant_playing") {
        this.setUiState("playing", "小睿正在回答", "回答播放完成後會自動恢復聆聽。");
        return;
      }
      if (conversation === "understanding" || diagnostics.asr_result === "started") {
        this.setUiState("processing", "正在理解您的問題", "請稍候，小睿正在準備回答。");
        return;
      }
      if (conversation === "speech_started") {
        this.setUiState("recording", "正在聆聽", "說完後稍候片刻，語音會自動送出。");
        return;
      }
      if (gateOpen && diagnostics.listening_active) {
        this.setUiState("ready", "可以開始說話", "小睿正在聆聽；完成一輪後可直接繼續下一輪。");
        return;
      }
      this.setUiState("connecting", "正在準備語音", "正在確認麥克風、welcome 與語音工作階段。");
    }

    setUiState(state, label, hint) {
      this.statusWrap.dataset.state = state;
      this.statusText.textContent = label;
      this.hint.textContent = hint;
    }

    renderControls() {
      this.voiceButton.disabled = this.starting;
      this.voiceButton.dataset.recording = "false";
      this.voiceLabel.textContent = this.started || this.starting ? "結束語音對話" : "開始語音對話";
    }

    scrollTranscript() {
      root.requestAnimationFrame(() => {
        this.transcript.scrollTop = this.transcript.scrollHeight;
      });
    }

    startFailureMessage(error) {
      if (error && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
        return "麥克風權限被拒絕，請在瀏覽器網站設定中允許後重試。";
      }
      return "無法啟動語音對話，請確認瀏覽器支援麥克風後重試。";
    }
  }

  const api = Object.freeze({
    PREVIEW_ENDPOINT,
    PRODUCTION_ENDPOINT,
    RichMeCanonicalApp,
    RichMeRealtimeWidget,
    resolveRealtimeEndpoint
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RichMeXiaoRui = api;

  if (root.document) {
    const widgetRoot = root.document.querySelector("[data-xiaorui-widget]");
    if (widgetRoot) new RichMeRealtimeWidget(widgetRoot);
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
