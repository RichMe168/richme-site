(() => {
  "use strict";

  const REALTIME_URL = "wss://xiaorui.skywingai.com/ws/realtime";
  const BACKEND_ORIGIN = "https://xiaorui.skywingai.com";
  const PCM_SAMPLE_RATE = 24000;
  const HANDSHAKE_TIMEOUT_MS = 10000;
  const MAX_RECONNECT_ATTEMPTS = 2;
  const MIME_CANDIDATES = [
    "audio/webm;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/x-m4a",
    "audio/m4a",
    "audio/ogg;codecs=opus",
    "audio/ogg"
  ];

  class XiaoRuiRealtimeWidget {
    constructor(root) {
      this.root = root;
      this.launcher = root.querySelector("[data-xiaorui-launch]");
      this.panel = root.querySelector("[data-xiaorui-panel]");
      this.closeButton = root.querySelector("[data-xiaorui-close]");
      this.statusWrap = root.querySelector("[data-xiaorui-status-wrap]");
      this.statusText = root.querySelector("[data-xiaorui-status]");
      this.transcript = root.querySelector("[data-xiaorui-transcript]");
      this.hint = root.querySelector("[data-xiaorui-hint]");
      this.voiceButton = root.querySelector("[data-xiaorui-voice]");
      this.voiceLabel = root.querySelector("[data-xiaorui-voice-label]");
      this.retryButton = root.querySelector("[data-xiaorui-retry]");

      this.socket = null;
      this.socketToken = 0;
      this.sessionReady = false;
      this.intentionalClose = true;
      this.connectAttempts = 0;
      this.handshakeTimer = null;
      this.reconnectTimer = null;

      this.mediaRecorder = null;
      this.mediaStream = null;
      this.audioChunks = [];
      this.discardRecording = false;

      this.audioContext = null;
      this.audioEpoch = 0;
      this.audioQueue = Promise.resolve();
      this.queuedAudioCount = 0;
      this.activeSources = new Set();
      this.playbackTimers = new Set();
      this.scheduledDrainTimer = null;
      this.nextPlaybackAt = 0;
      this.scheduledChunkKeys = new Set();
      this.playbackStarted = false;
      this.playbackFailed = false;

      this.welcomeAudio = null;
      this.welcomeExpected = false;
      this.welcomeStarted = false;
      this.welcomePlayed = false;
      this.welcomeActive = false;
      this.welcomeBarrier = Promise.resolve();
      this.resolveWelcomeBarrier = null;

      this.turnActive = false;
      this.serverTurnComplete = false;
      this.hasAudioChunks = false;
      this.activeGenerationId = "";
      this.replyText = "";
      this.userBubble = null;
      this.assistantBubble = null;
      this.state = "offline";

      if (!this.launcher || !this.panel || !this.closeButton || !this.voiceButton) return;
      this.bindEvents();
      this.renderControls();
    }

    bindEvents() {
      this.launcher.addEventListener("click", () => {
        if (this.panel.hidden) this.open();
        else this.close();
      });
      this.closeButton.addEventListener("click", () => this.close());
      this.voiceButton.addEventListener("click", () => void this.handleVoiceAction());
      this.retryButton.addEventListener("click", () => {
        this.retryButton.hidden = true;
        this.connectAttempts = 0;
        this.connect();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !this.panel.hidden) this.close();
      });
      window.addEventListener("online", () => {
        if (!this.panel.hidden && !this.sessionReady && !this.socket) this.connect();
      });
      window.addEventListener("pagehide", () => this.shutdown());
    }

    open() {
      this.panel.hidden = false;
      this.launcher.setAttribute("aria-expanded", "true");
      this.intentionalClose = false;
      void this.resumeAudioContext().catch(() => {});
      this.connect();
      this.closeButton.focus();
    }

    close() {
      this.panel.hidden = true;
      this.launcher.setAttribute("aria-expanded", "false");
      this.shutdown();
      this.launcher.focus();
    }

    shutdown() {
      this.intentionalClose = true;
      this.clearConnectionTimers();
      this.discardRecording = true;
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        try { this.mediaRecorder.stop(); } catch (error) { /* recorder already stopped */ }
      }
      this.mediaRecorder = null;
      this.audioChunks = [];
      this.releaseMicrophone();
      this.resetPlayback(true);
      this.resetWelcomeSession();
      this.turnActive = false;
      this.sessionReady = false;

      const socket = this.socket;
      this.socket = null;
      this.socketToken += 1;
      if (socket && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: "client.session.close" })); } catch (error) { /* best-effort close */ }
        try { socket.close(1000, "widget closed"); } catch (error) { /* already closing */ }
      } else if (socket && socket.readyState === WebSocket.CONNECTING) {
        try { socket.close(); } catch (error) { /* already closing */ }
      }
      this.setState("offline", "尚未連線");
      this.setHint("再次開啟小睿即可開始新的語音對話。");
      this.retryButton.hidden = true;
    }

    connect() {
      if (this.panel.hidden || typeof WebSocket === "undefined") {
        if (typeof WebSocket === "undefined") this.showConnectionError("此瀏覽器不支援即時連線，請改用新版瀏覽器。");
        return;
      }
      if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) return;

      this.clearConnectionTimers();
      this.intentionalClose = false;
      this.sessionReady = false;
      this.connectAttempts += 1;
      this.resetWelcomeSession();
      this.setState("connecting", this.connectAttempts > 1 ? "正在重新連線" : "正在連線");
      this.setHint("正在建立安全語音連線…");
      this.retryButton.hidden = true;

      const token = ++this.socketToken;
      let socket;
      try {
        socket = new WebSocket(REALTIME_URL);
      } catch (error) {
        this.handleSocketClose(token);
        return;
      }
      this.socket = socket;

      socket.addEventListener("open", () => {
        if (token !== this.socketToken) return;
        this.send({
          type: "client.session.start",
          role: "visitor",
          runtime_streaming_provider: "xiaomi_streaming"
        });
        this.handshakeTimer = window.setTimeout(() => {
          if (token !== this.socketToken || this.sessionReady) return;
          try { socket.close(4000, "handshake timeout"); } catch (error) { /* close handler will recover */ }
        }, HANDSHAKE_TIMEOUT_MS);
      });
      socket.addEventListener("message", (message) => {
        if (token !== this.socketToken) return;
        this.handleMessage(message.data);
      });
      socket.addEventListener("error", () => {
        if (token === this.socketToken) this.setHint("即時連線暫時不可用，正在嘗試恢復。");
      });
      socket.addEventListener("close", () => this.handleSocketClose(token));
    }

    handleSocketClose(token) {
      if (token !== this.socketToken) return;
      this.socket = null;
      this.sessionReady = false;
      this.clearHandshakeTimer();
      this.releaseMicrophone();
      this.resetPlayback(false);
      this.turnActive = false;
      if (this.intentionalClose || this.panel.hidden) return;

      if (this.connectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        this.setState("connecting", "連線中斷，正在恢復");
        const delay = 600 * this.connectAttempts;
        this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
        return;
      }
      this.showConnectionError("無法連上小睿，請檢查網路後重新連線。");
    }

    handleMessage(rawMessage) {
      let event;
      try {
        event = JSON.parse(rawMessage);
        if (!event || typeof event !== "object" || typeof event.type !== "string") throw new Error("InvalidEvent");
      } catch (error) {
        this.failTurn("收到無法辨識的回覆，請再試一次。");
        return;
      }

      const metadata = event.metadata || {};
      const generationId = String(event.generation_id || metadata.generation_id || "");

      switch (event.type) {
        case "server.session.created":
        case "server.provider.resolved":
          this.markSessionReady();
          break;
        case "server.asr.started":
        case "server.voice.turn.started":
          this.turnActive = true;
          this.setState("processing", "正在辨識語音");
          this.setHint("小睿正在理解您的問題…");
          break;
        case "server.asr.partial":
          this.setProvisionalUserText(event.text || metadata.text || "");
          break;
        case "server.asr.final":
          this.setFinalUserText(event.text ?? "");
          this.setState("processing", "正在思考");
          this.setHint("小睿正在準備回答…");
          break;
        case "server.generation.started":
          this.prepareGeneration(generationId);
          this.beginAssistantReply();
          this.setState("processing", "小睿正在回答");
          break;
        case "server.text.delta.live":
          this.appendAssistantDelta(event.delta || "");
          break;
        case "server.text.done.live":
          if (!this.replyText && event.text) this.setAssistantText(event.text);
          break;
        case "server.generation.completed":
          if (this.replyText) this.setAssistantText(this.replyText);
          break;
        case "server.tts.started":
        case "server.audio.stream.started":
          if (this.isWelcomeEvent(event)) break;
          this.setState("processing", "正在準備語音");
          this.setHint("即將播放小睿的回答…");
          break;
        case "server.tts.done":
        case "server.audio.segment.ready":
          if (this.isWelcomeEvent(event)) this.handleWelcomeEvent(event);
          break;
        case "server.audio.chunk":
          this.queuePcmChunk(event, generationId);
          break;
        case "server.audio.stream.completed":
          this.maybeFinishTurn();
          break;
        case "server.audio.output.ready":
          if (this.isWelcomeEvent(event)) this.handleWelcomeEvent(event);
          else this.maybeFinishTurn();
          break;
        case "server.voice.turn.completed":
          this.serverTurnComplete = true;
          if (this.welcomeExpected && !this.welcomeStarted) this.completeWelcome("not_emitted");
          this.maybeFinishTurn();
          break;
        case "server.asr.failed":
        case "server.asr.unavailable":
        case "server.voice.turn.failed":
          this.failTurn("這次沒有聽清楚，請再說一次。");
          break;
        case "server.generation.failed":
        case "server.error":
          this.failTurn("小睿暫時無法回答，請稍後再試。");
          break;
        case "server.tts.failed":
        case "server.tts.unavailable":
        case "server.audio.stream.failed":
        case "server.audio.output.failed":
        case "server.audio.output.unavailable":
          if (this.isWelcomeEvent(event)) {
            this.completeWelcome("failed");
            break;
          }
          this.handlePlaybackFailure();
          break;
        case "server.session.closed":
          if (!this.intentionalClose) {
            this.showConnectionError("語音連線已結束，請重新連線。");
            if (this.socket) this.socket.close();
          }
          break;
        default:
          break;
      }
    }

    markSessionReady() {
      this.clearHandshakeTimer();
      this.connectAttempts = 0;
      this.sessionReady = true;
      if (!this.turnActive) {
        this.setState("ready", "可以開始說話");
        this.setHint("按一下「開始說話」，說完後再按一次停止。");
      }
      this.renderControls();
    }

    async handleVoiceAction() {
      if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
        this.stopRecording();
        return;
      }
      if (!this.sessionReady) {
        this.connect();
        return;
      }
      if (this.turnActive) return;
      await this.startRecording();
    }

    async startRecording() {
      if (!window.MediaRecorder) {
        this.failTurn("此瀏覽器不支援語音錄製，請改用新版 Chrome、Edge 或 Safari。");
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.failTurn("此瀏覽器無法使用麥克風，請改用支援的安全瀏覽器。");
        return;
      }

      this.discardRecording = false;
      this.setState("processing", "正在開啟麥克風");
      this.setHint("請在瀏覽器提示中允許麥克風。");
      try {
        await this.resumeAudioContext();
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        if (this.panel.hidden || this.intentionalClose) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        this.mediaStream = stream;
        this.audioChunks = [];
        const selectedMime = this.chooseRecordingMimeType();
        const recorder = selectedMime
          ? new MediaRecorder(stream, { mimeType: selectedMime })
          : new MediaRecorder(stream);
        this.mediaRecorder = recorder;

        recorder.addEventListener("dataavailable", (event) => {
          if (event.data && event.data.size > 0) this.audioChunks.push(event.data);
        });
        recorder.addEventListener("error", () => {
          this.releaseMicrophone();
          this.mediaRecorder = null;
          this.failTurn("錄音發生問題，請重新嘗試。");
        });
        recorder.addEventListener("stop", () => void this.handleRecordingStopped(recorder, selectedMime), { once: true });
        recorder.start();
        this.setState("recording", "正在聆聽");
        this.setHint("說完後按「停止並送出」。");
      } catch (error) {
        this.releaseMicrophone();
        this.mediaRecorder = null;
        if (error && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
          this.failTurn("麥克風未獲允許。請在瀏覽器網站設定中允許後重試。");
        } else if (error && error.name === "NotFoundError") {
          this.failTurn("找不到可用的麥克風，請確認裝置後重試。");
        } else {
          this.failTurn("無法啟動錄音，請重新嘗試。");
        }
      }
    }

    stopRecording() {
      if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") return;
      this.setState("processing", "正在送出語音");
      this.setHint("請稍候，小睿正在接收您的問題…");
      try {
        this.mediaRecorder.stop();
      } catch (error) {
        this.releaseMicrophone();
        this.failTurn("無法完成錄音，請重新嘗試。");
      }
    }

    async handleRecordingStopped(recorder, selectedMime) {
      const chunks = this.audioChunks;
      this.audioChunks = [];
      this.mediaRecorder = null;
      this.releaseMicrophone();
      if (this.discardRecording || this.panel.hidden) return;

      const chunkMime = chunks.find((chunk) => chunk.type)?.type || "";
      const actualMime = recorder.mimeType || selectedMime || chunkMime;
      if (!actualMime || !this.isBackendCompatibleMime(actualMime)) {
        this.failTurn("此瀏覽器產生的錄音格式目前不支援，請改用新版 Chrome、Edge 或 Safari。");
        return;
      }
      const blob = new Blob(chunks, { type: actualMime });
      if (!blob.size) {
        this.failTurn("沒有錄到聲音，請再試一次。");
        return;
      }

      this.beginVoiceTurn();
      try {
        const audioB64 = await this.blobToBase64(blob);
        if (!this.sessionReady || !this.send({
          type: "client.voice.turn.start",
          audio_b64: audioB64,
          mime_type: actualMime,
          audio_bytes_length: blob.size
        })) {
          throw new Error("SocketNotReady");
        }
        this.setState("processing", "正在辨識語音");
        this.setHint("小睿正在理解您的問題…");
      } catch (error) {
        this.failTurn("語音送出失敗，請確認網路後再試一次。");
      }
    }

    beginVoiceTurn() {
      this.resetPlayback(false);
      this.turnActive = true;
      this.serverTurnComplete = false;
      this.hasAudioChunks = false;
      this.playbackFailed = false;
      this.activeGenerationId = "";
      this.replyText = "";
      this.userBubble = null;
      this.assistantBubble = null;
      this.setProvisionalUserText("語音辨識中…");
      if (!this.welcomePlayed) this.expectWelcome();
    }

    prepareGeneration(generationId) {
      if (generationId && this.activeGenerationId && generationId !== this.activeGenerationId) this.resetPlayback(false);
      this.activeGenerationId = generationId || this.activeGenerationId;
      this.replyText = "";
      this.serverTurnComplete = false;
      this.hasAudioChunks = false;
      this.playbackFailed = false;
    }

    chooseRecordingMimeType() {
      if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== "function") return "";
      return MIME_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
    }

    isBackendCompatibleMime(mimeType) {
      const baseMime = String(mimeType).split(";", 1)[0].trim().toLowerCase();
      return ["audio/webm", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/ogg"].includes(baseMime);
    }

    async blobToBase64(blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const pieces = [];
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
      }
      return btoa(pieces.join(""));
    }

    queuePcmChunk(event, generationId) {
      const metadata = event.metadata || {};
      if (metadata.skipped === true || Number(metadata.pcm_bytes_length) === 0) return;
      const resolvedGenerationId = generationId || this.activeGenerationId;
      const chunkKey = [
        resolvedGenerationId,
        metadata.segment_id || event.segment_id || "segment",
        metadata.chunk_index ?? event.chunk_index ?? this.scheduledChunkKeys.size
      ].join(":");
      if (this.scheduledChunkKeys.has(chunkKey)) return;
      this.scheduledChunkKeys.add(chunkKey);
      this.hasAudioChunks = true;
      if (this.welcomeExpected && !this.welcomeStarted) this.completeWelcome("not_emitted_before_formal_audio");
      this.queuedAudioCount += 1;
      const epoch = this.audioEpoch;
      this.audioQueue = this.audioQueue
        .then(() => this.welcomeBarrier)
        .then(() => this.schedulePcmChunk(event, resolvedGenerationId, epoch))
        .catch(() => this.handlePlaybackFailure())
        .finally(() => {
          if (epoch === this.audioEpoch) this.queuedAudioCount = Math.max(0, this.queuedAudioCount - 1);
          this.maybeFinishTurn();
        });
    }

    async schedulePcmChunk(event, generationId, epoch) {
      if (epoch !== this.audioEpoch || this.panel.hidden) return;
      const encoded = event.audio_chunk_b64 || event.metadata?.audio_chunk_b64 || "";
      if (!encoded) throw new Error("MissingAudioChunk");
      const bytes = this.base64ToBytes(encoded);
      const samples = this.pcm16leToFloat32(bytes);
      if (!samples.length) return;

      const context = await this.resumeAudioContext();
      if (epoch !== this.audioEpoch) return;
      const buffer = context.createBuffer(1, samples.length, PCM_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      if (buffer.duration < 0.02) return;

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const leadTime = this.nextPlaybackAt > context.currentTime ? 0.01 : 0.08;
      const startAt = Math.max(context.currentTime + leadTime, this.nextPlaybackAt);
      this.nextPlaybackAt = startAt + buffer.duration;
      this.activeSources.add(source);
      source.addEventListener("ended", () => {
        this.activeSources.delete(source);
        if (epoch === this.audioEpoch) this.maybeFinishTurn();
      }, { once: true });
      source.start(startAt);

      if (!this.playbackStarted) {
        this.playbackStarted = true;
        const timer = window.setTimeout(() => {
          this.playbackTimers.delete(timer);
          if (epoch !== this.audioEpoch) return;
          this.setState("playing", "正在播放回答");
          this.setHint("小睿說完後即可繼續提問。");
        }, Math.max(0, (startAt - context.currentTime) * 1000));
        this.playbackTimers.add(timer);
      }
    }

    base64ToBytes(value) {
      const binary = atob(String(value));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }

    pcm16leToFloat32(bytes) {
      if (!bytes.byteLength || bytes.byteLength % 2 !== 0) throw new Error("InvalidPCM16Audio");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const samples = new Float32Array(bytes.byteLength / 2);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = Math.max(-1, Math.min(1, view.getInt16(index * 2, true) / 32768));
      }
      return samples;
    }

    async resumeAudioContext() {
      if (!this.audioContext || this.audioContext.state === "closed") {
        const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextConstructor) throw new Error("AudioContextUnavailable");
        this.audioContext = new AudioContextConstructor();
      }
      if (this.audioContext.state === "suspended") await this.audioContext.resume();
      return this.audioContext;
    }

    isWelcomeEvent(event) {
      const metadata = event.metadata || {};
      return metadata.source_kind === "welcome"
        || metadata.welcome_playback === true
        || metadata.welcome_audio === true
        || event.source_kind === "welcome"
        || event.welcome_playback === true
        || event.welcome_audio === true;
    }

    expectWelcome() {
      if (this.welcomePlayed || this.welcomeExpected || this.welcomeStarted) return;
      this.welcomeExpected = true;
      this.welcomeBarrier = new Promise((resolve) => {
        this.resolveWelcomeBarrier = resolve;
      });
    }

    handleWelcomeEvent(event) {
      if (this.welcomePlayed || this.welcomeStarted) return;
      const metadata = event.metadata || {};
      const audioUrl = metadata.audio_url || event.audio_url || "";
      if (!audioUrl) return;

      let resolvedUrl;
      try {
        resolvedUrl = new URL(audioUrl, BACKEND_ORIGIN).href;
        if (new URL(resolvedUrl).origin !== BACKEND_ORIGIN) throw new Error("UnexpectedAudioOrigin");
      } catch (error) {
        this.completeWelcome("invalid_audio_url");
        return;
      }

      this.welcomeExpected = false;
      this.welcomeStarted = true;
      this.welcomeActive = true;
      this.setState("playing", "正在播放歡迎語");
      this.setHint("歡迎語播放後，小睿會接著回答。");

      const audio = new Audio(resolvedUrl);
      this.welcomeAudio = audio;
      audio.preload = "auto";
      audio.onended = () => this.completeWelcome("ended");
      audio.onerror = () => this.completeWelcome("error");
      const playResult = audio.play();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(() => this.completeWelcome("play_rejected"));
      }
    }

    completeWelcome(reason) {
      if (this.welcomePlayed && !this.welcomeActive && !this.welcomeExpected) return;
      const audio = this.welcomeAudio;
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        if (reason !== "ended") {
          try { audio.pause(); } catch (error) { /* media element already stopped */ }
        }
      }
      this.welcomeAudio = null;
      this.welcomeExpected = false;
      this.welcomeStarted = false;
      this.welcomeActive = false;
      this.welcomePlayed = true;
      const resolve = this.resolveWelcomeBarrier;
      this.resolveWelcomeBarrier = null;
      if (resolve) resolve();
      this.maybeFinishTurn();
    }

    resetWelcomeSession() {
      const audio = this.welcomeAudio;
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        try { audio.pause(); } catch (error) { /* media element already stopped */ }
      }
      const resolve = this.resolveWelcomeBarrier;
      this.welcomeAudio = null;
      this.welcomeExpected = false;
      this.welcomeStarted = false;
      this.welcomePlayed = false;
      this.welcomeActive = false;
      this.resolveWelcomeBarrier = null;
      this.welcomeBarrier = Promise.resolve();
      if (resolve) resolve();
    }

    maybeFinishTurn() {
      if (!this.turnActive || this.welcomeActive || this.queuedAudioCount > 0 || this.activeSources.size > 0) return;
      if (this.playbackFailed) {
        this.finishTurn("文字回覆已完成，但語音播放暫時無法使用。");
        return;
      }
      if (!this.serverTurnComplete) return;
      if (this.audioContext && this.nextPlaybackAt > this.audioContext.currentTime + 0.001) {
        if (!this.scheduledDrainTimer) {
          const delay = Math.max(0, (this.nextPlaybackAt - this.audioContext.currentTime) * 1000) + 20;
          this.scheduledDrainTimer = window.setTimeout(() => {
            this.scheduledDrainTimer = null;
            this.maybeFinishTurn();
          }, delay);
        }
        return;
      }
      this.finishTurn("回答完成，可以再說一次。");
    }

    finishTurn(message) {
      this.turnActive = false;
      this.serverTurnComplete = false;
      this.hasAudioChunks = false;
      this.activeGenerationId = "";
      this.nextPlaybackAt = 0;
      this.scheduledChunkKeys.clear();
      this.playbackStarted = false;
      if (this.scheduledDrainTimer) window.clearTimeout(this.scheduledDrainTimer);
      this.scheduledDrainTimer = null;
      this.userBubble = null;
      this.assistantBubble = null;
      if (this.sessionReady) {
        this.setState("ready", "可以繼續說話");
        this.setHint(message);
      }
    }

    handlePlaybackFailure() {
      if (this.playbackFailed) return;
      this.playbackFailed = true;
      this.resetPlayback(false);
      if (this.turnActive) this.finishTurn("文字回覆已完成，但語音播放失敗；您可以繼續提問。");
      else this.failTurn("語音播放失敗，請再試一次。");
    }

    failTurn(message) {
      this.discardRecording = true;
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        try { this.mediaRecorder.stop(); } catch (error) { /* recorder already stopped */ }
      }
      this.mediaRecorder = null;
      this.audioChunks = [];
      this.releaseMicrophone();
      this.resetPlayback(false);
      this.turnActive = false;
      this.setState("error", "這次未能完成");
      this.setHint(message);
      this.retryButton.hidden = true;
      this.renderControls();
    }

    showConnectionError(message) {
      this.sessionReady = false;
      this.setState("error", "連線失敗");
      this.setHint(message);
      this.retryButton.hidden = false;
      this.renderControls();
    }

    releaseMicrophone() {
      if (!this.mediaStream) return;
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    resetPlayback(closeContext) {
      this.audioEpoch += 1;
      this.activeSources.forEach((source) => {
        try { source.stop(); } catch (error) { /* source already ended */ }
      });
      this.activeSources.clear();
      this.playbackTimers.forEach((timer) => window.clearTimeout(timer));
      this.playbackTimers.clear();
      if (this.scheduledDrainTimer) window.clearTimeout(this.scheduledDrainTimer);
      this.scheduledDrainTimer = null;
      this.audioQueue = Promise.resolve();
      this.queuedAudioCount = 0;
      this.nextPlaybackAt = 0;
      this.scheduledChunkKeys.clear();
      this.playbackStarted = false;
      if (closeContext && this.audioContext && this.audioContext.state !== "closed") {
        void this.audioContext.close().catch(() => {});
        this.audioContext = null;
      }
    }

    send(payload) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
      try {
        this.socket.send(JSON.stringify(payload));
        return true;
      } catch (error) {
        return false;
      }
    }

    setProvisionalUserText(text) {
      if (!text) return;
      this.setUserText(text, true, false);
    }

    setFinalUserText(text) {
      this.setUserText(String(text ?? ""), false, true);
    }

    setUserText(text, partial, authoritative) {
      if (!text && !authoritative) return;
      if (!this.userBubble) this.userBubble = this.createBubble("您", "user");
      const paragraph = this.userBubble.querySelector("p");
      paragraph.textContent = text || "未辨識到語音";
      this.userBubble.dataset.partial = String(Boolean(partial));
      this.userBubble.dataset.final = String(Boolean(authoritative));
      this.scrollTranscript();
    }

    beginAssistantReply() {
      if (!this.assistantBubble) this.assistantBubble = this.createBubble("小睿", "assistant");
      this.setAssistantText("正在準備回答…");
    }

    appendAssistantDelta(delta) {
      if (!delta) return;
      if (!this.assistantBubble) this.assistantBubble = this.createBubble("小睿", "assistant");
      this.replyText += delta;
      this.setAssistantText(this.replyText);
    }

    setAssistantText(text) {
      if (!this.assistantBubble) this.assistantBubble = this.createBubble("小睿", "assistant");
      this.assistantBubble.querySelector("p").textContent = text;
      this.scrollTranscript();
    }

    createBubble(label, kind) {
      const article = document.createElement("article");
      article.className = `xiaorui-bubble xiaorui-bubble-${kind}`;
      const name = document.createElement("span");
      const paragraph = document.createElement("p");
      name.textContent = label;
      article.append(name, paragraph);
      this.transcript.append(article);
      this.scrollTranscript();
      return article;
    }

    scrollTranscript() {
      window.requestAnimationFrame(() => {
        this.transcript.scrollTop = this.transcript.scrollHeight;
      });
    }

    setState(state, label) {
      this.state = state;
      this.statusWrap.dataset.state = state;
      this.statusText.textContent = label;
      this.renderControls();
    }

    setHint(message) {
      this.hint.textContent = message;
    }

    renderControls() {
      if (!this.voiceButton || !this.voiceLabel) return;
      const recording = Boolean(this.mediaRecorder && this.mediaRecorder.state === "recording");
      this.voiceButton.dataset.recording = String(recording);
      if (recording) {
        this.voiceButton.disabled = false;
        this.voiceLabel.textContent = "停止並送出";
        return;
      }
      const canRecord = this.sessionReady && !this.turnActive && !["connecting", "processing", "playing"].includes(this.state);
      this.voiceButton.disabled = !canRecord;
      this.voiceLabel.textContent = canRecord ? (this.state === "error" ? "再說一次" : "開始說話") : "請稍候";
    }

    clearHandshakeTimer() {
      if (this.handshakeTimer) window.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }

    clearConnectionTimers() {
      this.clearHandshakeTimer();
      if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  const root = document.querySelector("[data-xiaorui-widget]");
  if (root) new XiaoRuiRealtimeWidget(root);
})();
