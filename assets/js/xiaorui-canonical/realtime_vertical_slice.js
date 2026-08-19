(function attachRealtimeVerticalSlice(root) {
  "use strict";

  const CONFIG = Object.freeze({
    welcomeUrl: "/static/audio/bingtang_session_welcome.mp3",
    speechThreshold: 0.012,
    silenceDurationMs: 900,
    postPlaybackEchoGuardMs: 700,
    analyserFftSize: 1024,
    pcmSampleRate: 24000,
    pcmSafetySeconds: 0.08,
    // Keep latency low while bounding future AudioBufferSourceNode backlog on mobile.
    pcmMaxSchedulingAheadSeconds: 0.5
  });

  function nowMs() { return Date.now(); }
  function perfNow() { return root.performance && root.performance.now ? root.performance.now() : nowMs(); }
  function makeId(prefix) { return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`; }
  function safeUrlPath(value) {
    const raw = String(value || "");
    if (!raw) return "";
    try {
      const base = root.location && root.location.href ? root.location.href : "http://localhost/";
      return new URL(raw, base).pathname;
    } catch (error) {
      return raw.split("?", 1)[0];
    }
  }

  function base64ToBytes(value) {
    const binary = root.atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function normalizeServerTerminalEvent(eventType, payload, activePlaybackGenerationId) {
    const metadata = (payload && payload.metadata) || {};
    const generationId = payload && (payload.generation_id || payload.generationId)
      || metadata.generation_id
      || metadata.generationId
      || activePlaybackGenerationId
      || "";
    if (
      eventType === "server.voice.turn.completed"
      || eventType === "server.generation.audio.completed"
    ) {
      return {
        isGenerationAudioTerminal: true,
        sourceEventType: eventType,
        generationId
      };
    }
    return { isGenerationAudioTerminal: false, sourceEventType: eventType, generationId: "" };
  }
  function payloadMetadata(payload) {
    return (payload && payload.metadata) || {};
  }

  function payloadErrorType(payload) {
    const metadata = payloadMetadata(payload);
    return String(
      (payload && (payload.error_type || payload.code))
      || (payload && payload.error && payload.error.type)
      || metadata.error_type
      || metadata.code
      || ""
    );
  }

  function payloadTurnId(payload) {
    const metadata = payloadMetadata(payload);
    return String(
      (payload && (payload.utterance_id || payload.utteranceId || payload.turn_id || payload.turnId))
      || metadata.utterance_id
      || metadata.utteranceId
      || metadata.turn_id
      || metadata.turnId
      || ""
    );
  }

  function cloneOwnerTuple(owner) {
    if (!owner) return null;
    return {
      restore_id: String(owner.restore_id || ""),
      socket_instance_id: String(owner.socket_instance_id || ""),
      session_id: String(owner.session_id || "")
    };
  }

  function ownerTupleKey(owner) {
    if (!owner) return "";
    return `${String(owner.restore_id || "")}:${String(owner.socket_instance_id || "")}:${String(owner.session_id || "")}`;
  }

  function classifyVoiceTurnFailure(payload) {
    const errorType = payloadErrorType(payload);
    if (errorType === "EmptyTranscript") return "recoverable_empty_transcript";
    return "nonrecoverable_turn_failure";
  }


  class InputGateController {
    constructor(trace) {
      this.value = "closed";
      this.trace = trace || (() => {});
    }
    set(value, reason, details) {
      const previous = this.value;
      this.value = value;
      this.trace("input_gate_changed", { previous_gate: previous, input_gate: value, reason, ...(details || {}) });
    }
    isOpen() { return this.value === "open"; }
  }

  class SessionWelcomeController {
    constructor(app) {
      this.app = app;
      this.welcomeId = "";
      this.started = false;
      this.completed = false;
    }
    reset() {
      this.welcomeId = "";
      this.started = false;
      this.completed = false;
    }
    owns(welcomeId) {
      return Boolean(this.started && welcomeId && welcomeId === this.welcomeId);
    }
    start() {
      if (this.started) return;
      this.welcomeId = makeId("welcome");
      this.started = true;
      this.completed = false;
      this.app.state.conversation_state = "connecting_welcoming";
      this.app.setPlaybackState("buffering", "session_welcome_started", { welcome_id: this.welcomeId });
      this.app.state.playback_scope = "session_welcome";
      this.app.state.welcome_id = this.welcomeId;
      this.app.inputGate.set("assistant_playing", "session_welcome_started", { welcome_id: this.welcomeId });
      this.app.updateDiagnostics({ welcome_started: true, welcome_completed: false, welcome_id: this.welcomeId });
      this.app.trace("Session Welcome Started", { welcome_id: this.welcomeId, playback_scope: "session_welcome", generation_id: "none" });
      const audio = this.app.welcomeAudio;
      if (!audio || typeof audio.play !== "function") {
        this.fail("welcome_audio_element_unavailable");
        return;
      }
      audio.src = `${CONFIG.welcomeUrl}?v=8b80c33e9dd249ea2258735f393121d6e7f1f65b4a695229fe26695508adcb4a`;
      const welcomeId = this.welcomeId;
      this.app.registerWelcomeElement(audio, welcomeId);
      this.app.recordEvent("welcome_play_attempted", { welcome_id: welcomeId, welcome_element_id: this.app.welcomeElementIdentity(audio), ...this.app.safeWelcomeMediaSnapshot(audio) });
      let promise;
      try {
        promise = audio.play();
      } catch (error) {
        this.app.recordEvent("welcome_play_rejected", { welcome_id: welcomeId, failure_reason: "play_threw", error_name: String(error && error.name || ""), error_message: String(error && error.message || error || ""), ...this.app.safeWelcomeMediaSnapshot(audio) });
        this.fail("local_welcome_play_failed", welcomeId);
        return;
      }
      this.app.welcomePlayPromise = promise || Promise.resolve();
      if (promise && typeof promise.then === "function") {
        promise.then(() => {
          if (!this.owns(welcomeId)) return;
          this.app.m2a.welcomePlayResolved = true;
          this.app.recordEvent("welcome_play_resolved", { welcome_id: welcomeId, success: true, ...this.app.safeWelcomeMediaSnapshot(audio) });
          this.app.updateM2aDiagnostics();
        }).catch((error) => {
          if (!this.owns(welcomeId)) return;
          this.app.m2a.welcomePlayRejected = true;
          this.app.m2a.failureReason = "welcome_play_rejected";
          this.app.recordEvent("welcome_play_rejected", { welcome_id: welcomeId, failure_reason: "play_promise_rejected", error_name: String(error && error.name || ""), error_message: String(error && error.message || error || ""), ...this.app.safeWelcomeMediaSnapshot(audio) });
          this.fail("local_welcome_play_failed", welcomeId);
        });
      } else {
        this.app.m2a.welcomePlayResolved = true;
        this.app.recordEvent("welcome_play_resolved", { welcome_id: welcomeId, success: true, promise_supported: false, ...this.app.safeWelcomeMediaSnapshot(audio) });
        this.app.updateM2aDiagnostics();
      }
    }
    complete(source, welcomeId) {
      if (welcomeId && !this.owns(welcomeId)) {
        this.app.trace("Stale Session Welcome Completion Ignored", { welcome_id: welcomeId, current_welcome_id: this.welcomeId });
        return;
      }
      if (this.completed) return;
      this.completed = true;
      if (this.app.m2a) this.app.m2a.welcomeEnded = true;
      if (typeof this.app.setPlaybackState === "function") this.app.setPlaybackState("idle", "welcome_completed", { welcome_id: this.welcomeId });
      else this.app.state.playback_state = "idle";
      this.app.state.playback_scope = "";
      this.app.updateDiagnostics({ welcome_completed: true, playback_state: "idle" });
      this.app.trace("Session Welcome Completed", { source, welcome_id: this.welcomeId });
      if (typeof this.app.updateM2aDiagnostics === "function") this.app.updateM2aDiagnostics();
      this.app.openListening("welcome_completed");
    }
    fail(reason, welcomeId) {
      if (welcomeId && !this.owns(welcomeId)) {
        this.app.trace("Stale Session Welcome Failure Ignored", { welcome_id: welcomeId, current_welcome_id: this.welcomeId, reason });
        return;
      }
      this.completed = true;
      if (this.app.m2a) this.app.m2a.failureReason = reason;
      this.app.trace("Session Welcome Failed", { reason, welcome_id: this.welcomeId });
      this.app.updateDiagnostics({ welcome_failed: true, welcome_failure_reason: reason });
      if (typeof this.app.updateM2aDiagnostics === "function") this.app.updateM2aDiagnostics();
      this.app.openListening("welcome_failed");
    }
  }


  class GenerationController {
    constructor(app) {
      this.app = app;
      this.reset();
    }
    reset() {
      this.generationId = "";
      this.utteranceId = "";
      this.serverGenerationAudioEndReceived = false;
      this.receivedSegments = new Set();
      this.completedSegments = new Set();
      this.generationCompleted = false;
      this.generationCompletedAt = "";
      this.totalPcmReceived = 0;
      this.totalPcmScheduled = 0;
      this.totalPcmPlayed = 0;
      this.totalPcmIgnored = 0;
      this.pcmIgnoredReasonCounts = { stale_generation: 0, missing_generation_id: 0, no_active_generation: 0, duplicate_chunk: 0 };
      this.generationTerminalEventType = "";
      this.generationTerminalEventReceivedAt = "";
      this.generationTerminalGenerationId = "";
      this.terminalEventOwnershipMismatchCount = 0;
      this.terminalEventMismatchActive = false;
      this.generationCompletionBlockers = ["server_generation_audio_end_not_received"];
    }
    start(generationId, utteranceId) {
      this.reset();
      this.generationId = generationId || makeId("gen");
      this.utteranceId = utteranceId || "";
      this.app.playback.beginGeneration(this.generationId);
      this.app.state.active_playback_generation_id = this.generationId;
      this.app.state.active_turn_id = this.utteranceId;
      this.app.state.generation_completed = false;
      this.app.state.generation_completed_at = "";
      this.app.state.playback_state = "buffering";
      this.app.state.conversation_state = "assistant_playing";
      this.app.state.listening_active = false;
      this.app.inputGate.set("closed", "generation_started", { generation_id: this.generationId, utterance_id: this.utteranceId });
      this.app.updateDiagnostics({ active_playback_generation_id: this.generationId, active_turn_id: this.utteranceId, generation_completed: false, generation_completed_at: "" });
    }
    segmentKey(segmentId, segmentIndex) { return `${segmentId || "seg"}:${Number(segmentIndex || 0)}`; }
    recordChunk(event) {
      const metadata = event.metadata || {};
      this.receivedSegments.add(this.segmentKey(metadata.segment_id || event.segment_id, metadata.segment_index));
      this.totalPcmReceived += 1;
      this.app.sessionPcmReceivedTotal += 1;
    }
    recordScheduled() {
      this.totalPcmScheduled += 1;
      this.app.sessionPcmScheduledTotal += 1;
    }
    recordPlayed(sourceId) {
      this.totalPcmPlayed += 1;
      this.app.sessionPcmPlayedTotal += 1;
      this.app.trace("PCM Played Counted", { generation_id: this.generationId, source_id: sourceId, generation_pcm_played: this.totalPcmPlayed });
    }
    recordIgnored(reason, details) {
      const normalizedReason = this.pcmIgnoredReasonCounts[reason] !== undefined ? reason : "stale_generation";
      this.totalPcmIgnored += 1;
      this.app.sessionPcmIgnoredTotal += 1;
      this.pcmIgnoredReasonCounts[normalizedReason] += 1;
      this.app.trace("PCM Chunk Ignored", { reason: normalizedReason, generation_id: this.generationId, ...(details || {}) });
      this.app.updateDiagnostics(this.diagnostics());
    }
    segmentCompleted(event) {
      const metadata = event.metadata || {};
      this.completedSegments.add(this.segmentKey(metadata.segment_id || event.segment_id, metadata.segment_index));
      this.generationCompletionBlockers = this.completionBlockers(this.app.playback);
    }
    markServerAudioEnd(event, terminal) {
      const normalizedTerminal = terminal || normalizeServerTerminalEvent(event && event.type, event, this.generationId || this.app.state.active_playback_generation_id || "");
      if (!normalizedTerminal.isGenerationAudioTerminal) return false;
      const terminalGenerationId = normalizedTerminal.generationId || this.generationId || this.app.state.active_playback_generation_id || "";
      if (this.generationId && terminalGenerationId && terminalGenerationId !== this.generationId) {
        this.terminalEventOwnershipMismatchCount += 1;
        this.terminalEventMismatchActive = true;
        this.generationCompletionBlockers = ["terminal_generation_mismatch"];
        this.app.trace("Terminal Event Ownership Mismatch", { source_event_type: normalizedTerminal.sourceEventType, terminal_generation_id: terminalGenerationId, active_generation_id: this.generationId });
        this.app.updateDiagnostics(this.diagnostics());
        return false;
      }
      if (!this.generationId && terminalGenerationId) this.generationId = terminalGenerationId;
      this.terminalEventMismatchActive = false;
      this.serverGenerationAudioEndReceived = true;
      this.generationTerminalEventType = normalizedTerminal.sourceEventType;
      this.generationTerminalEventReceivedAt = new Date().toISOString();
      this.generationTerminalGenerationId = terminalGenerationId;
      this.generationCompletionBlockers = this.completionBlockers(this.app.playback);
      this.app.trace("Generation Terminal Event Received", { source_event_type: this.generationTerminalEventType, generation_id: this.generationTerminalGenerationId, blockers: this.generationCompletionBlockers });
      this.app.updateDiagnostics(this.diagnostics());
      return true;
    }
    pendingSegmentCount() {
      let pending = 0;
      this.receivedSegments.forEach((key) => { if (!this.completedSegments.has(key)) pending += 1; });
      return pending;
    }
    completionBlockers(playback) {
      if (this.generationCompleted) return [];
      const blockers = [];
      const generationId = this.generationId;
      const audioContextCurrentTime = playback.audioContextCurrentTime();
      const scheduledEnd = playback.scheduledAudioEndTimeForGeneration(generationId);
      if (this.terminalEventMismatchActive) return ["terminal_generation_mismatch"];
      if (!this.serverGenerationAudioEndReceived || !this.generationTerminalEventType) blockers.push("server_generation_audio_end_not_received");
      if (this.pendingSegmentCount() !== 0) blockers.push("pending_segment_count");
      if (playback.pendingPcmChunkCount(generationId) !== 0) blockers.push("pending_pcm_chunk_count");
      if (playback.audioQueueLength(generationId) !== 0) blockers.push("audio_queue_length");
      if (playback.activeSourceCount(generationId) !== 0) blockers.push("active_pcm_source_count");
      if (scheduledEnd > audioContextCurrentTime + 0.001) blockers.push("scheduled_audio_end_time");
      return blockers;
    }
    canComplete(playback) {
      this.generationCompletionBlockers = this.completionBlockers(playback);
      return this.generationCompletionBlockers.length === 0;
    }
    completeIfReady(source) {
      if (this.generationCompleted) {
        this.generationCompletionBlockers = [];
        this.app.updateDiagnostics(this.diagnostics());
        return true;
      }
      if (!this.canComplete(this.app.playback)) {
        if (this.generationId) {
          this.app.state.generation_completed = false;
          this.app.state.playback_state = this.app.playback.hasPlaybackWork(this.generationId) ? "playing" : "buffering";
          this.app.state.conversation_state = "assistant_playing";
          this.app.state.listening_active = false;
          if (this.app.inputGate.value !== "closed") this.app.inputGate.set("closed", "generation_completion_blocked", { generation_id: this.generationId, source, blockers: this.generationCompletionBlockers });
        }
        this.app.updateDiagnostics(this.diagnostics());
        return false;
      }
      this.generationCompleted = true;
      this.generationCompletedAt = new Date().toISOString();
      this.generationCompletionBlockers = [];
      const completionOwner = this.app.awaitingPostRestoreTurn
        ? cloneOwnerTuple(this.app.postRestoreGenerationOwner || this.app.postRestoreRecordingOwner || this.app.postRestoreOwner)
        : null;
      if (completionOwner && !this.app.ensurePostRestoreOwnerValid(completionOwner, "post_restore_playback_completion_owner_mismatch", { generation_id: this.generationId, source })) {
        this.generationCompleted = false;
        this.generationCompletedAt = "";
        return false;
      }
      this.app.state.generation_completed = true;
      this.app.state.generation_completed_at = this.generationCompletedAt;
      this.app.state.active_playback_generation_id = "";
      this.app.state.active_turn_id = "";
      this.app.state.playback_state = "idle";
      this.app.state.conversation_state = "listening";
      this.app.state.listening_active = true;
      this.app.state.last_assistant_playback_completed_at = perfNow();
      this.app.inputGate.set("open", "generation_audio_completed", {
        generation_id: this.generationId,
        source,
        restore_id: completionOwner && completionOwner.restore_id || "",
        session_id: completionOwner && completionOwner.session_id || "",
        socket_instance_id: completionOwner && completionOwner.socket_instance_id || "",
        owner_tuple: ownerTupleKey(completionOwner)
      });
      this.app.trace("Generation Audio Completed", { generation_id: this.generationId, source, websocket_connected: this.app.state.websocket_connected, terminal_event_type: this.generationTerminalEventType });
      if (typeof this.app.maybeRecordFirstTurnCompleted === "function") this.app.maybeRecordFirstTurnCompleted(this.generationId, source);
      if (typeof this.app.maybeRecordPostRestoreTurnCompleted === "function") this.app.maybeRecordPostRestoreTurnCompleted(this.generationId, source);
      this.app.updateDiagnostics(this.diagnostics());
      return true;
    }
    completionDeltaMs() {
      if (!this.generationTerminalEventReceivedAt || !this.generationCompletedAt) return null;
      return new Date(this.generationCompletedAt).getTime() - new Date(this.generationTerminalEventReceivedAt).getTime();
    }
    diagnostics() {
      const blockers = this.generationCompleted ? [] : this.completionBlockers(this.app.playback);
      this.generationCompletionBlockers = blockers;
      return {
        server_generation_audio_end_received: this.serverGenerationAudioEndReceived,
        pending_segment_count: this.pendingSegmentCount(),
        pcm_received: this.totalPcmReceived,
        pcm_scheduled: this.totalPcmScheduled,
        pcm_played: this.totalPcmPlayed,
        pcm_ignored: this.totalPcmIgnored,
        generation_pcm_received: this.totalPcmReceived,
        generation_pcm_scheduled: this.totalPcmScheduled,
        generation_pcm_played: this.totalPcmPlayed,
        generation_pcm_ignored: this.totalPcmIgnored,
        session_pcm_received_total: this.app.sessionPcmReceivedTotal,
        session_pcm_scheduled_total: this.app.sessionPcmScheduledTotal,
        session_pcm_played_total: this.app.sessionPcmPlayedTotal,
        session_pcm_ignored_total: this.app.sessionPcmIgnoredTotal,
        pcm_ignored_reason_counts: { ...this.pcmIgnoredReasonCounts },
        generation_completed: this.generationCompleted,
        generation_completed_at: this.generationCompletedAt,
        generation_terminal_event_type: this.generationTerminalEventType,
        generation_terminal_event_received_at: this.generationTerminalEventReceivedAt,
        generation_terminal_generation_id: this.generationTerminalGenerationId,
        terminal_event_ownership_mismatch_count: this.terminalEventOwnershipMismatchCount,
        generation_completion_blockers: blockers,
        completion_time_delta_ms: this.completionDeltaMs()
      };
    }
  }

  class PlaybackController {
    constructor(app) {
      this.app = app;
      this.context = null;
      this.activeSources = new Map();
      this.audioQueue = [];
      this.pendingPcmChunks = [];
      this.scheduledAudioEndTime = 0;
      this.scheduledAudioEndTimes = new Map();
      this.scheduledChunkIds = new Set();
      this.playedSourceIds = new Set();
    }
    setAudioContext(context) { this.context = context; }
    clearForLifecycle(reason, restoreId) {
      const sourceCount = this.activeSources.size;
      const queueCount = this.audioQueue.length;
      this.app.playbackEpoch += 1;
      this.activeSources.forEach((source, sourceId) => {
        source.onended = () => this.app.trace("Stale PCM Source End Ignored", { source_id: sourceId, blocked_reason: "lifecycle_invalidated", restore_id: restoreId || "" });
        try { if (typeof source.stop === "function") source.stop(0); } catch (error) { this.app.trace("PCM Source Stop Failed", { source_id: sourceId, error_message: String(error && error.message || error || "") }); }
      });
      this.activeSources.clear();
      this.audioQueue = [];
      this.pendingPcmChunks = [];
      this.scheduledAudioEndTime = 0;
      this.scheduledAudioEndTimes.clear();
      this.scheduledChunkIds.clear();
      this.playedSourceIds.clear();
      this.app.recordEvent("pcm_sources_cleared", { reason, restore_id: restoreId || "", active_pcm_source_count_before: sourceCount });
      this.app.recordEvent("pcm_queue_cleared", { reason, restore_id: restoreId || "", audio_queue_length_before: queueCount });
      this.app.updateDiagnostics(this.diagnostics());
    }
    beginGeneration(generationId) {
      if (!generationId) return;
      this.scheduledAudioEndTimes.set(generationId, this.audioContextCurrentTime());
    }
    audioContextCurrentTime() { return this.context ? Number(this.context.currentTime || 0) : 0; }
    currentGenerationId() { return this.app.generation.generationId || this.app.state.active_playback_generation_id || ""; }
    activeSourceCount(generationId) {
      const target = generationId || "";
      if (!target) return this.activeSources.size;
      let count = 0;
      this.activeSources.forEach((source) => { if (source.__xiaorui_generation_id === target) count += 1; });
      return count;
    }
    audioQueueLength(generationId) {
      const target = generationId || "";
      return target ? this.audioQueue.filter((item) => item.generation_id === target).length : this.audioQueue.length;
    }
    pendingPcmChunkCount(generationId) {
      const target = generationId || "";
      return target ? this.pendingPcmChunks.filter((item) => item.generation_id === target).length : this.pendingPcmChunks.length;
    }
    activeSourceIds(generationId) {
      const target = generationId || "";
      return Array.from(this.activeSources.entries()).filter(([, source]) => !target || source.__xiaorui_generation_id === target).map(([id]) => id);
    }
    scheduledAudioEndTimeForGeneration(generationId) {
      if (!generationId) return this.scheduledAudioEndTime;
      return Number(this.scheduledAudioEndTimes.get(generationId) || 0);
    }
    hasPlaybackWork(generationId) {
      return this.audioQueueLength(generationId) > 0 || this.activeSourceCount(generationId) > 0 || this.pendingPcmChunkCount(generationId) > 0;
    }
    scheduleChunk(event) {
      const metadata = event.metadata || {};
      const generationId = metadata.generation_id || event.generation_id || "";
      const activeGenerationId = this.app.generation.generationId || "";
      if (!generationId) {
        this.app.generation.recordIgnored("missing_generation_id", { event_type: event.type || "server.audio.chunk" });
        return;
      }
      if (!activeGenerationId) {
        this.app.generation.recordIgnored("no_active_generation", { generation_id: generationId });
        return;
      }
      if (generationId !== activeGenerationId || this.app.generation.generationCompleted) {
        this.app.generation.recordIgnored("stale_generation", { generation_id: generationId, active_generation_id: activeGenerationId, generation_completed: this.app.generation.generationCompleted });
        return;
      }
      const segmentId = metadata.segment_id || event.segment_id || "seg";
      const chunkIndex = metadata.chunk_index || event.chunk_index || 0;
      const chunkId = `${generationId}:${segmentId}:${chunkIndex}`;
      if (this.scheduledChunkIds.has(chunkId) || this.playedSourceIds.has(chunkId)) {
        this.app.generation.recordIgnored("duplicate_chunk", { chunk_id: chunkId });
        return;
      }
      this.app.generation.recordChunk(event);
      this.app.state.playback_state = "playing";
      this.app.state.conversation_state = "assistant_playing";
      this.app.state.listening_active = false;
      if (this.app.inputGate.value !== "closed") this.app.inputGate.set("closed", "pcm_playback_started", { generation_id: generationId });
      const queueItem = { id: chunkId, generation_id: generationId, segment_id: segmentId, chunk_id: chunkId, event };
      this.scheduledChunkIds.add(chunkId);
      this.pendingPcmChunks.push(queueItem);
      this.drainPendingPcm(generationId, false);
    }
    drainPendingPcm(generationId, continueAtAnchor) {
      if (!generationId || generationId !== this.app.generation.generationId) return;
      let continueScheduling = Boolean(continueAtAnchor);
      while (this.pendingPcmChunks.length > 0) {
        const queueItem = this.pendingPcmChunks[0];
        if (queueItem.generation_id !== generationId) {
          this.pendingPcmChunks.shift();
          continue;
        }
        const currentTime = this.audioContextCurrentTime();
        const scheduledEnd = this.scheduledAudioEndTimeForGeneration(generationId);
        const schedulingAhead = Math.max(0, scheduledEnd - currentTime);
        if (schedulingAhead >= CONFIG.pcmMaxSchedulingAheadSeconds && (scheduledEnd > 0 || this.activeSourceCount(generationId) > 0)) break;
        this.pendingPcmChunks.shift();
        this.schedulePendingChunk(queueItem, continueScheduling);
        continueScheduling = true;
      }
      this.app.updateDiagnostics(this.diagnostics());
    }
    schedulePendingChunk(queueItem, continueAtAnchor) {
      const { event, generation_id: generationId, id: chunkId, segment_id: segmentId } = queueItem;
      const metadata = event.metadata || {};
      this.audioQueue.push(queueItem);
      const bytes = base64ToBytes(event.audio_chunk_b64 || metadata.audio_chunk_b64 || "");
      const playbackApi = root.XiaoRuiPlaybackAdapter;
      const samples = playbackApi.pcm16leBytesToFloat32(bytes);
      const sampleRate = Number(metadata.sample_rate || CONFIG.pcmSampleRate);
      const buffer = this.context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.__xiaorui_generation_id = generationId;
      source.__xiaorui_chunk_id = chunkId;
      source.__xiaorui_playback_epoch = this.app.playbackEpoch;
      source.connect(this.context.destination);
      const currentGenerationEnd = this.scheduledAudioEndTimeForGeneration(generationId);
      const scheduledStart = continueAtAnchor
        ? Math.max(this.context.currentTime, currentGenerationEnd || 0)
        : Math.max(this.context.currentTime + CONFIG.pcmSafetySeconds, currentGenerationEnd || 0);
      const scheduledEnd = scheduledStart + buffer.duration;
      this.scheduledAudioEndTimes.set(generationId, scheduledEnd);
      this.scheduledAudioEndTime = Math.max(this.scheduledAudioEndTime || 0, scheduledEnd);
      this.activeSources.set(chunkId, source);
      this.app.generation.recordScheduled();
      source.onended = () => {
        if (source.__xiaorui_playback_epoch !== this.app.playbackEpoch) {
          this.app.trace("Stale PCM Source End Ignored", { chunk_id: chunkId, generation_id: generationId, blocked_reason: "playback_epoch_mismatch" });
          return;
        }
        if (this.playedSourceIds.has(chunkId)) {
          this.app.trace("PCM Source End Duplicate Ignored", { chunk_id: chunkId, generation_id: generationId });
          return;
        }
        this.playedSourceIds.add(chunkId);
        this.activeSources.delete(chunkId);
        this.audioQueue = this.audioQueue.filter((item) => item.id !== chunkId);
        this.app.generation.recordPlayed(chunkId);
        this.app.trace("PCM Source Ended", { chunk_id: chunkId, generation_id: generationId, audio_queue_length: this.audioQueueLength(generationId), active_pcm_source_count: this.activeSourceCount(generationId) });
        this.drainPendingPcm(generationId, true);
        this.app.generation.completeIfReady("source_ended");
        this.app.updateDiagnostics(this.diagnostics());
      };
      source.start(scheduledStart);
      this.app.updateDiagnostics(this.diagnostics());
    }
    diagnostics() {
      const generationId = this.currentGenerationId();
      return {
        audio_queue_length: this.audioQueueLength(generationId),
        active_pcm_source_count: this.activeSourceCount(generationId),
        active_pcm_source_ids: this.activeSourceIds(generationId),
        pending_pcm_chunk_count: this.pendingPcmChunkCount(generationId),
        scheduled_audio_end_time: this.scheduledAudioEndTimeForGeneration(generationId),
        audio_context_current_time: this.audioContextCurrentTime(),
        scheduling_ahead_ms: Math.max(0, this.scheduledAudioEndTimeForGeneration(generationId) - this.audioContextCurrentTime()) * 1000
      };
    }
  }

  class TurnController {
    constructor(app) {
      this.app = app;
      this.mediaRecorder = null;
      this.chunks = [];
      this.currentUtteranceId = "";
      this.turnCount = 0;
      this.recordingInstanceId = "";
      this.recordingOwner = null;
    }
    beginRecording() {
      this.app.recordEvent("recorder_start_attempted", { utterance_id: this.currentUtteranceId || "", recorder_mime_type: this.app.selectedMime || "" });
      if (!this.app.inputGate.isOpen()) {
        this.app.recordEvent("recorder_error", this.app.failureDetails("recorder_input_gate_closed", null, { recorder_mime_type: this.app.selectedMime || "" }));
        return false;
      }
      if (!this.app.state.listening_active) {
        this.app.recordEvent("recorder_error", this.app.failureDetails("recorder_listening_inactive", null, { recorder_mime_type: this.app.selectedMime || "" }));
        return false;
      }
      const stream = this.app.stream;
      if (!stream || !root.XiaoRuiRecorderAdapter.streamHasLiveAudioTrack(stream)) {
        this.app.recordEvent("recorder_error", this.app.failureDetails("microphone_stream_not_ready", null, { recorder_mime_type: this.app.selectedMime || "" }));
        return false;
      }
      this.currentUtteranceId = makeId("utt");
      const recordingInstanceId = makeId("recorder");
      this.recordingInstanceId = recordingInstanceId;
      const recordingOwner = this.app.bindPostRestoreRecordingOwner(recordingInstanceId);
      if (this.app.awaitingPostRestoreTurn && !recordingOwner) {
        this.recordingInstanceId = "";
        return false;
      }
      this.recordingOwner = recordingOwner;
      this.app.state.active_turn_id = this.currentUtteranceId;
      this.chunks = [];
      const options = this.app.selectedMime ? { mimeType: this.app.selectedMime } : undefined;
      try {
        this.mediaRecorder = new root.MediaRecorder(stream, options);
      } catch (error) {
        this.app.recordEvent("recorder_error", this.app.failureDetails("mediarecorder_constructor_failed", error, { utterance_id: this.currentUtteranceId, recorder_mime_type: this.app.selectedMime || "" }));
        this.currentUtteranceId = "";
        this.app.state.active_turn_id = "";
        return false;
      }
      const recorder = this.mediaRecorder;
      this.mediaRecorder.addEventListener("dataavailable", (event) => {
        if (!this.isCurrentRecorder(recorder, recordingInstanceId)) {
          this.app.recordEvent("recorder_error", this.app.failureDetails("stale_recorder_dataavailable_ignored", null, { utterance_id: this.currentUtteranceId, recorder_instance_id: recordingInstanceId }));
          return;
        }
        if (!this.ownerStillValid(recordingOwner, "recorder_dataavailable_owner_mismatch", { utterance_id: this.currentUtteranceId, recorder_instance_id: recordingInstanceId })) return;
        const size = event && event.data && event.data.size ? event.data.size : 0;
        this.app.recordEvent("recorder_dataavailable", { utterance_id: this.currentUtteranceId, blob_size: size, recorder_mime_type: (this.mediaRecorder && this.mediaRecorder.mimeType) || this.app.selectedMime || "" });
        if (event.data && event.data.size) this.chunks.push(event.data);
      });
      this.mediaRecorder.addEventListener("error", (event) => this.app.recordEvent("recorder_error", this.app.failureDetails("mediarecorder_error", event && event.error, { utterance_id: this.currentUtteranceId, recorder_instance_id: recordingInstanceId, recorder_mime_type: (this.mediaRecorder && this.mediaRecorder.mimeType) || this.app.selectedMime || "" })));
      this.mediaRecorder.addEventListener("stop", () => this.onStop(recordingInstanceId, recorder), { once: true });
      try {
        this.mediaRecorder.start();
      } catch (error) {
        this.app.recordEvent("recorder_error", this.app.failureDetails("mediarecorder_start_failed", error, { utterance_id: this.currentUtteranceId, recorder_mime_type: (this.mediaRecorder && this.mediaRecorder.mimeType) || this.app.selectedMime || "" }));
        this.mediaRecorder = null;
        this.currentUtteranceId = "";
        this.app.state.active_turn_id = "";
        return false;
      }
      this.app.state.conversation_state = "speech_started";
      this.app.recordEvent("recorder_started", { utterance_id: this.currentUtteranceId, recorder_instance_id: recordingInstanceId, recorder_mime_type: this.mediaRecorder.mimeType, mediarecorder_mime_type: this.mediaRecorder.mimeType, socket_instance_id: this.app.socketInstanceId });
      this.app.recordPostRestoreRecordingStarted(this.currentUtteranceId);
      this.app.updateDiagnostics({ active_turn_id: this.currentUtteranceId });
      return true;
    }
    isCurrentRecorder(recorder, recordingInstanceId) {
      return recorder === this.mediaRecorder && recordingInstanceId && recordingInstanceId === this.recordingInstanceId;
    }
    ownerStillValid(owner, reason, extra) {
      if (!owner) return true;
      return this.app.ensurePostRestoreOwnerValid(owner, reason, extra);
    }
    mediaRecorderState() {
      return this.mediaRecorder && this.mediaRecorder.state ? String(this.mediaRecorder.state) : "";
    }
    clearForLifecycle(reason, restoreId) {
      const recorder = this.mediaRecorder;
      const recorderState = this.mediaRecorderState();
      const recordingInstanceId = this.recordingInstanceId;
      this.recordingOwner = null;
      this.recordingInstanceId = "";
      this.currentUtteranceId = "";
      this.chunks = [];
      this.mediaRecorder = null;
      this.app.voiceActive = false;
      this.app.silenceStartedAt = 0;
      if (recorder && recorder.state === "recording") {
        try { recorder.stop(); } catch (error) { this.app.recordEvent("recorder_error", this.app.failureDetails("recorder_lifecycle_stop_failed", error, { restore_id: restoreId || "", recorder_instance_id: recordingInstanceId })); }
      }
      this.app.recordEvent("recorder_state_cleared", { reason, restore_id: restoreId || "", recorder_instance_id: recordingInstanceId || "", media_recorder_state: recorderState });
    }
    stopRecording() {
      if (this.mediaRecorder && this.mediaRecorder.state === "recording") this.mediaRecorder.stop();
    }
    failedEventOwnsCurrentTurn(event) {
      const failedTurnId = payloadTurnId(event);
      const activeTurnId = this.app.state.active_turn_id || this.currentUtteranceId || "";
      if (!failedTurnId) return { owns: true, failedTurnId: activeTurnId };
      return { owns: failedTurnId === activeTurnId, failedTurnId };
    }
    cleanupFailedTurn() {
      if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
        try { this.mediaRecorder.stop(); } catch (error) { this.app.trace("Recorder Cleanup Failed", { reason: String(error && error.message || error) }); }
      }
      this.mediaRecorder = null;
      this.recordingOwner = null;
      this.chunks = [];
      this.currentUtteranceId = "";
      this.app.voiceActive = false;
      this.app.silenceStartedAt = 0;
    }
    completeEmptyTranscript(event) {
      const ownership = this.failedEventOwnsCurrentTurn(event);
      if (!ownership.owns) {
        this.app.staleTurnFailureIgnoredCount += 1;
        this.app.updateDiagnostics({ stale_turn_failure_ignored_count: this.app.staleTurnFailureIgnoredCount });
        this.app.trace("Stale Turn Failure Ignored", { failed_turn_id: ownership.failedTurnId, current_active_turn_id: this.app.state.active_turn_id, error_type: payloadErrorType(event) });
        return;
      }
      const failedTurnId = ownership.failedTurnId || this.app.state.active_turn_id || this.currentUtteranceId || "";
      this.cleanupFailedTurn();
      this.app.recoverableEmptyTranscriptCount += 1;
      this.app.lastFailedTurnId = failedTurnId;
      this.app.state.active_turn_id = "";
      this.app.state.active_playback_generation_id = "";
      this.app.state.playback_state = "idle";
      this.app.state.conversation_state = "listening";
      this.app.state.listening_active = true;
      this.app.inputGate.set("open", "empty_transcript_recovered", { turn_id: failedTurnId });
      this.app.pendingBlobs = [];
      this.app.updateDiagnostics({
        asr_result: "empty",
        last_turn_outcome: "empty_transcript",
        last_completed_turn_id: failedTurnId,
        last_completed_turn_outcome: "empty_transcript",
        last_failed_turn_id: failedTurnId,
        last_failed_turn_error_type: "EmptyTranscript",
        active_turn_id: "",
        current_active_turn_id: "",
        active_playback_generation_id: "",
        pending_utterance_count: 0,
        playback_state: "idle",
        conversation_state: "listening",
        listening_active: true,
        websocket_connected: Boolean(this.app.state.websocket_connected),
        last_empty_transcript_at: new Date().toISOString(),
        recoverable_empty_transcript_count: this.app.recoverableEmptyTranscriptCount
      });
      this.app.trace("Empty Transcript Recovered", { turn_id: failedTurnId, websocket_connected: this.app.state.websocket_connected });
    }
    fail(event) {
      const errorType = payloadErrorType(event) || "VoiceTurnFailed";
      this.cleanupFailedTurn();
      this.app.state.conversation_state = "error";
      this.app.state.playback_state = "idle";
      this.app.state.listening_active = false;
      this.app.inputGate.set("closed", "voice_turn_failed", { error_type: errorType });
      this.app.updateDiagnostics({ conversation_state: "error", playback_state: "idle", error_type: errorType, last_failed_turn_error_type: errorType });
    }
    onStop(recordingInstanceId, recorder) {
      if (!this.isCurrentRecorder(recorder || this.mediaRecorder, recordingInstanceId)) {
        this.app.recordEvent("recorder_error", this.app.failureDetails("stale_recorder_stop_ignored", null, { recorder_instance_id: recordingInstanceId || "" }));
        return;
      }
      const recordingOwner = cloneOwnerTuple(this.recordingOwner);
      if (!this.ownerStillValid(recordingOwner, "recorder_stop_owner_mismatch", { recorder_instance_id: recordingInstanceId || "" })) {
        this.mediaRecorder = null;
        this.recordingOwner = null;
        this.chunks = [];
        this.currentUtteranceId = "";
        return;
      }
      const utteranceId = this.currentUtteranceId;
      this.app.state.conversation_state = "understanding";
      this.app.state.listening_active = false;
      this.app.inputGate.set("committed_processing", "blob_ready", { utterance_id: utteranceId, recorder_instance_id: recordingInstanceId || "" });
      const mime = (this.mediaRecorder && this.mediaRecorder.mimeType) || this.app.selectedMime || "audio/webm";
      const blob = new Blob(this.chunks, { type: mime });
      this.turnCount += 1;
      this.app.recordEvent("audio_chunk_created", {
        utterance_id: utteranceId,
        turn_index: this.turnCount,
        blob_size: blob.size,
        mime_type: mime,
        recorder_mime_type: mime,
        restore_id: recordingOwner && recordingOwner.restore_id || "",
        session_id: recordingOwner && recordingOwner.session_id || "",
        socket_instance_id: recordingOwner && recordingOwner.socket_instance_id || "",
        owner_tuple: ownerTupleKey(recordingOwner)
      });
      this.app.updateDiagnostics({
        turn_count: this.turnCount,
        blob_size: blob.size,
        mediarecorder_mime_type: mime,
        active_turn_id: utteranceId,
        current_active_turn_id: utteranceId,
        conversation_state: "understanding",
        listening_active: false
      });
      this.app.trace("Audio Blob Ready", { utterance_id: utteranceId, blob_size: blob.size, mime_type: mime });
      this.mediaRecorder = null;
      this.recordingOwner = null;
      this.chunks = [];
      void this.app.sendVoiceBlob(blob, utteranceId, this.turnCount, mime, recordingOwner);
    }
  }

  class RebuildRealtimeApp {
    constructor(options) {
      this.options = options || {};
      this.traceEntries = [];
      this.diagnostics = {
        repository_role: "REBUILD",
        provider: "xiaomi",
        locale: "zh-TW",
        test_scope: "full_realtime_vertical_slice",
        branch: "rebuild/v0.7.3-device-audio-multiturn",
        commit: this.options.commit || "fb5c632",
        input_gate: "closed",
        conversation_state: "disconnected",
        playback_state: "idle",
        websocket_connected: false,
        current_session_id: "",
        socket_instance_id: "",
        turn_count: 0,
        asr_result: "not_started",
        raw_assistant_text: "",
        normalized_assistant_text: "",
        display_text: "",
        tts_input_text: "",
        simplified_character_violation_count: 0,
        pcm_received: 0,
        pcm_scheduled: 0,
        pcm_played: 0,
        pcm_ignored: 0,
        generation_pcm_received: 0,
        generation_pcm_scheduled: 0,
        generation_pcm_played: 0,
        generation_pcm_ignored: 0,
        session_pcm_received_total: 0,
        session_pcm_scheduled_total: 0,
        session_pcm_played_total: 0,
        session_pcm_ignored_total: 0,
        pcm_ignored_reason_counts: { stale_generation: 0, missing_generation_id: 0, no_active_generation: 0, duplicate_chunk: 0 },
        pending_segment_count: 0,
        pending_pcm_chunk_count: 0,
        audio_queue_length: 0,
        active_pcm_source_count: 0,
        generation_completed: false,
        generation_terminal_event_type: "",
        generation_terminal_event_received_at: "",
        generation_terminal_generation_id: "",
        terminal_event_ownership_mismatch_count: 0,
        generation_completion_blockers: [],
        completion_time_delta_ms: null,
        active_playback_generation_id: "",
        active_turn_id: "",
        websocket_close_initiator: "",
        websocket_close_code: "",
        websocket_close_reason: "",
        websocket_close_timestamp: "",
        websocket_close_stack_hint: "",
        last_server_event_before_close: "",
        last_client_event_before_close: "",
        ignored_stale_socket_close_count: 0,
        last_completed_turn_id: "",
        last_completed_turn_outcome: "",
        last_failed_turn_id: "",
        last_failed_turn_error_type: "",
        current_active_turn_id: "",
        last_successful_transcript: "",
        last_empty_transcript_at: "",
        recoverable_empty_transcript_count: 0,
        stale_turn_failure_ignored_count: 0,
        local_empty_capture_skipped: false,
        pending_utterance_count: 0,
        ordered_event_trace: [],
        m2a_pass: false,
        m2a_status: "not_started",
        microphone_ready: false,
        microphone_failure_reason: "",
        first_turn_completed: false,
        lifecycle_state: "ACTIVE",
        reconnect_attempt: 0,
        foreground_restore_in_progress: false,
        m2_startup_completed: false,
        post_restore_turn_completed: false,
        restore_id: "",
        post_restore_owner_tuple: "",
        post_restore_recording_owner_tuple: "",
        post_restore_owner_mismatch_count: 0
      };
      this.state = { conversation_state: "disconnected", playback_state: "idle", listening_active: false, generation_completed: false, websocket_connected: false, active_playback_generation_id: "", active_turn_id: "" };
      this.inputGate = new InputGateController((label, detail) => this.trace(label, detail));
      this.welcome = new SessionWelcomeController(this);
      this.generation = new GenerationController(this);
      this.playback = new PlaybackController(this);
      this.turn = new TurnController(this);
      this.pendingBlobs = [];
      this.socket = null;
      this.pageSessionInstanceId = makeId("page_session");
      this.eventSequence = 0;
      this.startupInProgress = false;
      this.lifecycleInterrupted = false;
      this.audioContextResumePromise = null;
      this.welcomePlayPromise = null;
      this.m2a = {
        audioContextRunningConfirmed: false,
        audioContextResumeResolved: false,
        audioContextResumeRejected: false,
        welcomePlayResolved: false,
        welcomePlayRejected: false,
        welcomePlaying: false,
        welcomeEnded: false,
        welcomeErrored: false,
        failureReason: ""
      };
      this.sessionReady = false;
      this.currentSessionId = "";
      this.socketInstanceCounter = 0;
      this.socketInstanceId = "";
      this.socketSessionReadyResolvers = new Map();
      this.websocketCloseInitiator = "";
      this.lastServerEventBeforeClose = "";
      this.lastClientEventBeforeClose = "";
      this.ignoredStaleSocketCloseCount = 0;
      this.recoverableEmptyTranscriptCount = 0;
      this.staleTurnFailureIgnoredCount = 0;
      this.sessionPcmReceivedTotal = 0;
      this.sessionPcmScheduledTotal = 0;
      this.sessionPcmPlayedTotal = 0;
      this.sessionPcmIgnoredTotal = 0;
      this.lastCompletedTurnId = "";
      this.lastFailedTurnId = "";
      this.lastSuccessfulTranscript = "";
      this.stream = null;
      this.microphoneReady = false;
      this.microphoneFailureReason = "";
      this.firstTurnCompleted = false;
      this.postRestoreTurnId = "";
      this.postRestoreTurnCompleted = false;
      this.awaitingPostRestoreTurn = false;
      this.postRestoreOwner = null;
      this.postRestoreRecordingOwner = null;
      this.postRestoreGenerationOwner = null;
      this.postRestoreOwnerMismatchCount = 0;
      this.audioContext = null;
      this.vadAnalyser = null;
      this.vadSource = null;
      this.vadRunning = false;
      this.voiceActive = false;
      this.silenceStartedAt = 0;
      this.selectedMime = "";
      this.lifecycleState = "ACTIVE";
      this.restoreNeeded = false;
      this.restoreInProgress = false;
      this.restoreAttempt = 0;
      this.restoreToken = "";
      this.m2StartupCompleted = false;
      this.explicitSessionEpoch = 0;
      this.vadLoopToken = 0;
      this.playbackEpoch = 0;
      this.welcomeAudio = this.options.welcomeAudio;
      this.render = this.options.render || (() => {});
      this.installLifecycleDiagnostics();
    }
    setPlaybackState(value, reason, details) {
      const previous = this.state.playback_state || "";
      this.state.playback_state = value;
      if (previous !== value) this.recordEvent("playback_state_changed", { previous_playback_state: previous, playback_state: value, reason, ...(details || {}) });
    }
    updateDiagnostics(patch) {
      Object.assign(this.diagnostics, patch || {}, {
        input_gate: this.inputGate.value,
        conversation_state: this.state.conversation_state,
        playback_state: this.state.playback_state,
        listening_active: Boolean(this.state.listening_active),
        websocket_connected: Boolean(this.state.websocket_connected),
        current_session_id: this.currentSessionId || "",
        socket_instance_id: this.socketInstanceId || "",
        active_playback_generation_id: this.state.active_playback_generation_id || "",
        active_turn_id: this.state.active_turn_id || "",
        last_server_event_before_close: this.lastServerEventBeforeClose || "",
        last_client_event_before_close: this.lastClientEventBeforeClose || "",
        ignored_stale_socket_close_count: this.ignoredStaleSocketCloseCount,
        current_active_turn_id: this.state.active_turn_id || "",
        recoverable_empty_transcript_count: this.recoverableEmptyTranscriptCount || 0,
        stale_turn_failure_ignored_count: this.staleTurnFailureIgnoredCount || 0,
        microphone_ready: this.microphoneReadyForRecording(),
        microphone_failure_reason: this.microphoneFailureReason || "",
        first_turn_completed: Boolean(this.firstTurnCompleted),
        lifecycle_state: this.lifecycleState,
        reconnect_attempt: this.restoreAttempt,
        foreground_restore_in_progress: Boolean(this.restoreInProgress),
        m2_startup_completed: Boolean(this.m2StartupCompleted),
        post_restore_turn_completed: Boolean(this.postRestoreTurnCompleted),
        restore_id: this.restoreToken || "",
        post_restore_owner_tuple: ownerTupleKey(this.postRestoreOwner),
        post_restore_recording_owner_tuple: ownerTupleKey(this.postRestoreRecordingOwner),
        post_restore_owner_mismatch_count: this.postRestoreOwnerMismatchCount,
        ordered_event_trace: this.traceEntries.slice(),
        m2a_pass: false,
        ...this.generation.diagnostics(),
        ...this.playback.diagnostics()
      });
      this.render(this.diagnostics, this.traceEntries);
    }
    trace(label, detail) {
      this.recordEvent(label, detail);
    }
    recordEvent(eventName, detail) {
      const source = detail || {};
      const entry = {
        sequence: ++this.eventSequence,
        event: eventName,
        label: eventName,
        timestamp: new Date().toISOString(),
        session_instance_id: this.pageSessionInstanceId,
        current_session_id: this.currentSessionId || "",
        socket_instance_id: this.socketInstanceId || "",
        generation_id: source.generation_id || this.state.active_playback_generation_id || this.generation.generationId || "",
        audio_context_state: this.audioContext ? String(this.audioContext.state || "") : "",
        playback_state: this.state.playback_state || "",
        input_gate: this.inputGate ? this.inputGate.value : "",
        is_secure_context: Boolean(root.isSecureContext),
        page_protocol: root.location && root.location.protocol ? root.location.protocol : "",
        websocket_ready_state: this.websocketReadyState(),
        recorder_mime_type: source.recorder_mime_type || (this.turn && this.turn.mediaRecorder && this.turn.mediaRecorder.mimeType) || this.selectedMime || "",
        media_recorder_state: source.media_recorder_state || (this.turn && this.turn.mediaRecorderState ? this.turn.mediaRecorderState() : ""),
        microphone_track_state: source.microphone_track_state || this.microphoneTrackState(),
        lifecycle_state: this.lifecycleState,
        reconnect_attempt: this.restoreAttempt,
        ...(source || {})
      };
      this.traceEntries.push(entry);
      if (this.traceEntries.length > 200) this.traceEntries.shift();
      this.updateDiagnostics({ last_trace: eventName });
    }
    websocketReadyState() {
      if (!this.socket || typeof this.socket.readyState === "undefined") return "";
      return this.socket.readyState;
    }
    microphoneTrackState() {
      if (!this.stream || typeof this.stream.getTracks !== "function") return "";
      return this.stream.getTracks().filter((track) => !track.kind || track.kind === "audio").map((track) => String(track.readyState || "")).join(",");
    }
    mediaStreamActive() {
      return Boolean(this.stream && this.stream.active && root.XiaoRuiRecorderAdapter.streamHasLiveAudioTrack(this.stream));
    }
    failureDetails(blockedReason, error, extra) {
      return {
        success: false,
        blocked_reason: blockedReason,
        error_name: String(error && error.name || ""),
        error_message: String(error && error.message || error || ""),
        lifecycle_state: this.lifecycleState,
        is_secure_context: Boolean(root.isSecureContext),
        page_protocol: root.location && root.location.protocol ? root.location.protocol : "",
        recorder_mime_type: (extra && extra.recorder_mime_type) || (this.turn && this.turn.mediaRecorder && this.turn.mediaRecorder.mimeType) || this.selectedMime || "",
        websocket_ready_state: this.websocketReadyState(),
        media_recorder_state: this.turn && this.turn.mediaRecorderState ? this.turn.mediaRecorderState() : "",
        microphone_track_state: this.microphoneTrackState(),
        audio_context_state: this.audioContext ? String(this.audioContext.state || "") : "",
        session_id: this.currentSessionId || "",
        socket_instance_id: this.socketInstanceId || "",
        ...(extra || {})
      };
    }
    microphoneReadyForRecording() {
      return Boolean(this.stream && root.XiaoRuiRecorderAdapter.streamHasLiveAudioTrack(this.stream) && this.vadRunning && this.vadAnalyser);
    }
    recordMicrophoneBlockedAfterWelcome(reason) {
      const blockedReason = this.microphoneFailureReason || "microphone_not_ready_after_welcome";
      this.recordEvent("microphone_start_failed", this.failureDetails(blockedReason, null, { reason }));
      this.updateDiagnostics({ microphone_ready: false, microphone_failure_reason: blockedReason, mic_stream_active: false });
    }
    maybeRecordFirstTurnCompleted(generationId, source) {
      if (this.firstTurnCompleted || this.turn.turnCount !== 1) return;
      this.firstTurnCompleted = true;
      this.recordEvent("first_turn_completed", { generation_id: generationId, source, turn_count: this.turn.turnCount, success: true });
      this.updateDiagnostics({ first_turn_completed: true });
    }
    captureOwnerTuple(restoreId, socketInstanceId, sessionId) {
      return cloneOwnerTuple({
        restore_id: restoreId || this.restoreToken || "",
        socket_instance_id: socketInstanceId || this.socketInstanceId || "",
        session_id: sessionId || this.currentSessionId || ""
      });
    }
    currentOwnerTuple() {
      return this.captureOwnerTuple(this.restoreToken, this.socketInstanceId, this.currentSessionId);
    }
    sameOwnerTuple(left, right) {
      return ownerTupleKey(left) !== "" && ownerTupleKey(left) === ownerTupleKey(right);
    }
    ensurePostRestoreOwnerValid(expectedOwner, blockedReason, extra) {
      if (!expectedOwner) return true;
      const activeOwner = this.currentOwnerTuple();
      if (this.sameOwnerTuple(expectedOwner, activeOwner)) return true;
      this.handlePostRestoreOwnerMismatch(blockedReason, expectedOwner, activeOwner, extra);
      return false;
    }
    handlePostRestoreOwnerMismatch(blockedReason, expectedOwner, actualOwner, extra) {
      this.postRestoreOwnerMismatchCount += 1;
      this.awaitingPostRestoreTurn = false;
      this.postRestoreTurnCompleted = false;
      this.postRestoreTurnId = "";
      this.postRestoreRecordingOwner = null;
      this.postRestoreGenerationOwner = null;
      this.pendingBlobs = this.pendingBlobs.filter((item) => !item.owner || !this.sameOwnerTuple(item.owner, expectedOwner));
      this.state.listening_active = false;
      this.state.conversation_state = "disconnected";
      this.state.playback_state = "idle";
      this.restoreNeeded = true;
      this.inputGate.set("closed", "post_restore_owner_mismatch", { blocked_reason: blockedReason, expected_owner_tuple: ownerTupleKey(expectedOwner), actual_owner_tuple: ownerTupleKey(actualOwner) });
      this.recordEvent("post_restore_owner_mismatch", {
        blocked_reason: blockedReason,
        expected_restore_id: expectedOwner && expectedOwner.restore_id || "",
        expected_socket_instance_id: expectedOwner && expectedOwner.socket_instance_id || "",
        expected_session_id: expectedOwner && expectedOwner.session_id || "",
        actual_restore_id: actualOwner && actualOwner.restore_id || "",
        actual_socket_instance_id: actualOwner && actualOwner.socket_instance_id || "",
        actual_session_id: actualOwner && actualOwner.session_id || "",
        expected_owner_tuple: ownerTupleKey(expectedOwner),
        actual_owner_tuple: ownerTupleKey(actualOwner),
        ...(extra || {})
      });
      this.updateDiagnostics({ pending_utterance_count: this.pendingBlobs.length });
    }
    bindPostRestoreRecordingOwner(recordingInstanceId) {
      if (!this.awaitingPostRestoreTurn) return null;
      if (!this.postRestoreOwner) {
        this.recordEvent("recorder_error", this.failureDetails("post_restore_owner_missing", null, { recorder_instance_id: recordingInstanceId || "" }));
        this.inputGate.set("closed", "post_restore_owner_missing");
        this.state.listening_active = false;
        return null;
      }
      if (!this.ensurePostRestoreOwnerValid(this.postRestoreOwner, "post_restore_recording_owner_mismatch", { recorder_instance_id: recordingInstanceId || "" })) return null;
      this.postRestoreRecordingOwner = cloneOwnerTuple(this.postRestoreOwner);
      return cloneOwnerTuple(this.postRestoreRecordingOwner);
    }
    recordPostRestoreRecordingStarted(utteranceId) {
      if (!this.awaitingPostRestoreTurn || this.postRestoreTurnId) return;
      this.postRestoreTurnId = utteranceId || "";
      const owner = cloneOwnerTuple(this.postRestoreRecordingOwner || this.postRestoreOwner);
      if (!this.ensurePostRestoreOwnerValid(owner, "post_restore_recording_started_owner_mismatch", { utterance_id: this.postRestoreTurnId })) return;
      this.recordEvent("first_post_restore_recording_started", { utterance_id: this.postRestoreTurnId, success: true, lifecycle_state: this.lifecycleState, restore_id: owner && owner.restore_id || "", session_id: owner && owner.session_id || "", socket_instance_id: owner && owner.socket_instance_id || "", owner_tuple: ownerTupleKey(owner) });
    }
    recordPostRestoreAudioSent(utteranceId, turnIndex, blobSize, mime) {
      if (!this.awaitingPostRestoreTurn || !this.postRestoreTurnId || utteranceId !== this.postRestoreTurnId) return;
      const owner = cloneOwnerTuple(this.postRestoreRecordingOwner || this.postRestoreOwner);
      if (!this.ensurePostRestoreOwnerValid(owner, "post_restore_audio_sent_owner_mismatch", { utterance_id: utteranceId })) return;
      this.recordEvent("first_post_restore_audio_sent", { utterance_id: utteranceId, turn_index: turnIndex, blob_size: blobSize, mime_type: mime, success: true, restore_id: owner && owner.restore_id || "", session_id: owner && owner.session_id || "", socket_instance_id: owner && owner.socket_instance_id || "", owner_tuple: ownerTupleKey(owner) });
    }
    recordPostRestoreAsrReceived(utteranceId) {
      if (!this.awaitingPostRestoreTurn || !this.postRestoreTurnId || utteranceId !== this.postRestoreTurnId) return;
      const owner = cloneOwnerTuple(this.postRestoreGenerationOwner || this.postRestoreRecordingOwner || this.postRestoreOwner);
      if (!this.ensurePostRestoreOwnerValid(owner, "post_restore_asr_owner_mismatch", { utterance_id: utteranceId })) return;
      this.recordEvent("first_post_restore_asr_received", { utterance_id: utteranceId, success: true, restore_id: owner && owner.restore_id || "", session_id: owner && owner.session_id || "", socket_instance_id: owner && owner.socket_instance_id || "", owner_tuple: ownerTupleKey(owner) });
    }
    recordPostRestoreGenerationStarted(generationId, utteranceId) {
      if (!this.awaitingPostRestoreTurn || !this.postRestoreTurnId || utteranceId !== this.postRestoreTurnId) return;
      const owner = cloneOwnerTuple(this.postRestoreGenerationOwner || this.postRestoreRecordingOwner || this.postRestoreOwner);
      if (!this.ensurePostRestoreOwnerValid(owner, "post_restore_generation_started_owner_mismatch", { generation_id: generationId, utterance_id: utteranceId })) return;
      this.recordEvent("first_post_restore_generation_started", { generation_id: generationId, utterance_id: utteranceId, success: true, restore_id: owner && owner.restore_id || "", session_id: owner && owner.session_id || "", socket_instance_id: owner && owner.socket_instance_id || "", owner_tuple: ownerTupleKey(owner) });
    }
    maybeRecordPostRestoreTurnCompleted(generationId, source) {
      if (!this.awaitingPostRestoreTurn || this.postRestoreTurnCompleted) return;
      const owner = cloneOwnerTuple(this.postRestoreGenerationOwner || this.postRestoreRecordingOwner || this.postRestoreOwner);
      if (!this.ensurePostRestoreOwnerValid(owner, "post_restore_turn_completed_owner_mismatch", { generation_id: generationId, source })) return;
      this.postRestoreTurnCompleted = true;
      this.awaitingPostRestoreTurn = false;
      this.postRestoreRecordingOwner = null;
      this.postRestoreGenerationOwner = null;
      this.recordEvent("first_post_restore_turn_completed", { generation_id: generationId, utterance_id: this.postRestoreTurnId || "", source, success: true, restore_id: owner && owner.restore_id || "", session_id: owner && owner.session_id || "", socket_instance_id: owner && owner.socket_instance_id || "", owner_tuple: ownerTupleKey(owner) });
      this.updateDiagnostics({ post_restore_turn_completed: true });
    }
    updateM2aDiagnostics() {
      const localReady = this.m2a.audioContextRunningConfirmed
        && this.m2a.welcomePlayResolved
        && this.m2a.welcomePlaying
        && this.m2a.welcomeEnded
        && !this.lifecycleInterrupted
        && !this.m2a.failureReason;
      this.updateDiagnostics({
        m2a_status: this.m2a.failureReason || this.lifecycleInterrupted ? "failed_or_blocked" : (localReady ? "implemented_iphone_acceptance_pending" : "startup_pending"),
        m2a_local_acceptance_ready: localReady,
        m2a_pass: false,
        audio_context_running_confirmed: this.m2a.audioContextRunningConfirmed,
        welcome_play_resolved: this.m2a.welcomePlayResolved,
        welcome_media_playing: this.m2a.welcomePlaying,
        welcome_media_ended: this.m2a.welcomeEnded,
        lifecycle_interrupted: this.lifecycleInterrupted,
        m2a_failure_reason: this.m2a.failureReason || ""
      });
    }
    installLifecycleDiagnostics() {
      const doc = root.document;
      if (doc && typeof doc.addEventListener === "function") {
        doc.addEventListener("visibilitychange", () => {
          const visibilityState = doc.visibilityState || "";
          this.recordLifecycleEvent("visibilitychange", { visibility_state: visibilityState });
          if (visibilityState === "hidden") this.enterBackground("visibilitychange");
          if (visibilityState === "visible") void this.requestForegroundRestore("visibilitychange");
        });
      }
      if (typeof root.addEventListener === "function") {
        ["pagehide", "pageshow", "focus", "blur"].forEach((type) => root.addEventListener(type, (event) => {
          this.recordLifecycleEvent(type, { persisted: Boolean(event && event.persisted) });
          if (type === "pagehide") this.enterBackground("pagehide");
          if (type === "pageshow" || type === "focus") void this.requestForegroundRestore(type);
        }));
      }
    }
    recordLifecycleEvent(type, details) {
      const interruptsStartup = this.startupInProgress && (type === "visibilitychange" || type === "pagehide");
      if (interruptsStartup) {
        this.lifecycleInterrupted = true;
        this.m2a.failureReason = `lifecycle_${type}`;
      }
      this.recordEvent("lifecycle_event", { lifecycle_type: type, blocked_reason: interruptsStartup ? this.m2a.failureReason : "", ...(details || {}) });
      this.updateM2aDiagnostics();
    }
    setLifecycleState(nextState, trigger, details) {
      const previousState = this.lifecycleState || "ACTIVE";
      if (previousState === nextState && !(details && details.force_record)) return;
      const previousSessionId = details && details.previous_session_id !== undefined ? details.previous_session_id : this.currentSessionId || "";
      const previousSocketId = details && details.previous_socket_instance_id !== undefined ? details.previous_socket_instance_id : this.socketInstanceId || "";
      this.lifecycleState = nextState;
      this.recordEvent("lifecycle_state_changed", {
        previous_lifecycle_state: previousState,
        lifecycle_state: nextState,
        lifecycle_trigger: trigger || "",
        previous_session_id: previousSessionId,
        current_session_id: this.currentSessionId || "",
        previous_socket_instance_id: previousSocketId,
        socket_instance_id: this.socketInstanceId || "",
        reconnect_attempt: this.restoreAttempt,
        ...(details || {})
      });
      this.updateDiagnostics({ lifecycle_state: nextState });
    }
    lifecycleSnapshot(extra) {
      return {
        websocket_ready_state: this.websocketReadyState(),
        session_id: this.currentSessionId || "",
        current_session_id: this.currentSessionId || "",
        socket_instance_id: this.socketInstanceId || "",
        media_recorder_state: this.turn && this.turn.mediaRecorderState ? this.turn.mediaRecorderState() : "",
        microphone_track_state: this.microphoneTrackState(),
        audio_context_state: this.audioContext ? String(this.audioContext.state || "") : "",
        playback_state: this.state.playback_state || "",
        generation_id: this.generation.generationId || this.state.active_playback_generation_id || "",
        input_gate: this.inputGate.value,
        ...(extra || {})
      };
    }
    enterBackground(trigger) {
      if (this.lifecycleState === "BACKGROUNDED" && this.restoreNeeded) return;
      const previousSessionId = this.currentSessionId || "";
      const previousSocketId = this.socketInstanceId || "";
      this.restoreToken = makeId("restore_cancelled");
      this.restoreInProgress = false;
      this.restoreNeeded = this.m2StartupCompleted;
      this.postRestoreOwner = null;
      this.postRestoreRecordingOwner = null;
      this.postRestoreGenerationOwner = null;
      this.setLifecycleState("BACKGROUNDED", trigger, { previous_session_id: previousSessionId, previous_socket_instance_id: previousSocketId });
      this.recordEvent("background_entered", this.lifecycleSnapshot({ lifecycle_trigger: trigger, previous_session_id: previousSessionId, previous_socket_instance_id: previousSocketId }));
      this.inputGate.set("closed", "lifecycle_backgrounded", { lifecycle_trigger: trigger });
      this.state.listening_active = false;
      this.state.conversation_state = "backgrounded";
      this.state.playback_state = "idle";
      this.turn.clearForLifecycle("lifecycle_backgrounded", this.restoreToken);
      this.stopVadRuntime("lifecycle_backgrounded");
      this.playback.clearForLifecycle("lifecycle_backgrounded", this.restoreToken);
      this.generation.reset();
      this.state.active_playback_generation_id = "";
      this.state.active_turn_id = "";
      this.pendingBlobs = [];
      this.updateDiagnostics({ conversation_state: "backgrounded", playback_state: "idle", listening_active: false, pending_utterance_count: 0 });
    }
    async requestForegroundRestore(trigger) {
      if (!this.m2StartupCompleted || !this.restoreNeeded) {
        this.recordEvent("foreground_restore_requested", this.lifecycleSnapshot({ lifecycle_trigger: trigger, blocked_reason: this.m2StartupCompleted ? "restore_not_needed" : "m2_startup_not_completed" }));
        return false;
      }
      if (this.restoreInProgress || this.lifecycleState === "RECONNECTING" || this.lifecycleState === "RESTORING_AUDIO") {
        this.recordEvent("foreground_restore_deduplicated", this.lifecycleSnapshot({ lifecycle_trigger: trigger, blocked_reason: "restore_already_in_progress" }));
        return false;
      }
      this.restoreInProgress = true;
      this.restoreAttempt += 1;
      const restoreId = makeId("restore");
      this.restoreToken = restoreId;
      const previousSessionId = this.currentSessionId || "";
      const previousSocketId = this.socketInstanceId || "";
      this.recordEvent("foreground_restore_requested", this.lifecycleSnapshot({ lifecycle_trigger: trigger, restore_id: restoreId, previous_session_id: previousSessionId, previous_socket_instance_id: previousSocketId }));
      this.setLifecycleState("RECONNECTING", trigger, { restore_id: restoreId, previous_session_id: previousSessionId, previous_socket_instance_id: previousSocketId });
      this.recordEvent("reconnect_started", { restore_id: restoreId, lifecycle_trigger: trigger, previous_session_id: previousSessionId, previous_socket_instance_id: previousSocketId });
      try {
        this.invalidateCurrentSocketForRestore(restoreId, previousSocketId, previousSessionId);
        await this.connectWebSocket({ awaitSessionReady: true, lifecycleRestore: true, restoreId });
        if (!this.isCurrentRestore(restoreId)) return false;
        this.setLifecycleState("RESTORING_AUDIO", trigger, { restore_id: restoreId, previous_session_id: previousSessionId, previous_socket_instance_id: previousSocketId });
        await this.restoreAudioRuntime(restoreId);
        if (!this.isCurrentRestore(restoreId)) return false;
        if (this.readyAfterRestore()) {
          this.finishForegroundRestoreReady(restoreId);
          return true;
        }
        this.failLifecycleRestore("restore_ready_conditions_not_met", null, { restore_id: restoreId });
      } catch (error) {
        if (this.isCurrentRestore(restoreId)) this.failLifecycleRestore("reconnect_or_restore_failed", error, { restore_id: restoreId });
      }
      return false;
    }
    isCurrentRestore(restoreId) {
      return this.restoreInProgress && this.restoreToken === restoreId && this.lifecycleState !== "BACKGROUNDED";
    }
    invalidateCurrentSocketForRestore(restoreId, previousSocketId, previousSessionId) {
      const oldSocket = this.socket;
      const oldReadyState = this.websocketReadyState();
      this.socket = null;
      this.sessionReady = false;
      this.state.websocket_connected = false;
      this.currentSessionId = "";
      this.recordEvent("stale_socket_invalidated", { restore_id: restoreId, previous_socket_instance_id: previousSocketId || "", previous_session_id: previousSessionId || "", websocket_ready_state: oldReadyState });
      if (oldSocket && typeof oldSocket.close === "function") {
        try { oldSocket.close(); } catch (error) { this.recordEvent("reconnect_failed", this.failureDetails("old_socket_close_failed", error, { restore_id: restoreId, previous_socket_instance_id: previousSocketId || "" })); }
      }
      this.updateDiagnostics({ websocket_connected: false, current_session_id: "", previous_session_id: previousSessionId || "" });
    }
    async restoreAudioRuntime(restoreId) {
      this.turn.clearForLifecycle("foreground_restore", restoreId);
      this.recordEvent("microphone_restore_attempted", { restore_id: restoreId });
      if (this.mediaStreamActive()) {
        this.recordEvent("microphone_stream_reused", { restore_id: restoreId, success: true, microphone_track_state: this.microphoneTrackState() });
      } else {
        const nav = root.navigator || {};
        if (!nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== "function") {
          this.microphoneReady = false;
          this.microphoneFailureReason = "microphone_api_unavailable";
          this.recordEvent("microphone_restore_failed", this.failureDetails("microphone_api_unavailable", null, { restore_id: restoreId }));
          return false;
        }
        try {
          this.stream = await nav.mediaDevices.getUserMedia(root.XiaoRuiRecorderAdapter.audioInputConstraints());
          this.recordEvent("microphone_stream_recreated", { restore_id: restoreId, success: true, microphone_track_state: this.microphoneTrackState() });
        } catch (error) {
          this.microphoneReady = false;
          this.microphoneFailureReason = "getUserMedia_rejected";
          this.recordEvent("microphone_restore_failed", this.failureDetails("getUserMedia_rejected", error, { restore_id: restoreId }));
          return false;
        }
      }
      if (!this.isCurrentRestore(restoreId)) return false;
      const audioReady = await this.restoreAudioContext(restoreId);
      if (!audioReady || !this.isCurrentRestore(restoreId)) return false;
      this.recordEvent("vad_restore_attempted", { restore_id: restoreId });
      if (!this.setupVadRuntime("foreground_restore", restoreId)) {
        this.recordEvent("vad_restore_failed", this.failureDetails(this.microphoneFailureReason || "vad_setup_failed", null, { restore_id: restoreId }));
        return false;
      }
      this.recordEvent("vad_restored", { restore_id: restoreId, success: true });
      return true;
    }
    async restoreAudioContext(restoreId) {
      this.recordEvent("audio_context_restore_attempted", { restore_id: restoreId, audio_context_state: this.audioContext ? String(this.audioContext.state || "") : "" });
      if (!this.audioContext) this.createAudioContext("foreground_restore", restoreId);
      if (this.audioContext && this.audioContext.state === "suspended" && typeof this.audioContext.resume === "function") {
        try {
          await this.audioContext.resume();
          this.recordEvent("audio_context_resumed", { restore_id: restoreId, success: true, audio_context_state: String(this.audioContext.state || "") });
        } catch (error) {
          this.recordEvent("audio_context_restore_failed", this.failureDetails("audio_context_resume_failed", error, { restore_id: restoreId }));
          this.audioContext = null;
          this.createAudioContext("foreground_restore_recreate", restoreId);
        }
      }
      if (this.audioContext && this.audioContext.state === "suspended" && typeof this.audioContext.resume === "function") {
        try { await this.audioContext.resume(); } catch (error) { this.recordEvent("audio_context_restore_failed", this.failureDetails("audio_context_recreated_resume_failed", error, { restore_id: restoreId })); }
      }
      const running = this.audioContext && this.audioContext.state === "running";
      if (!running) this.recordEvent("audio_context_restore_failed", this.failureDetails("audio_context_not_running", null, { restore_id: restoreId }));
      return Boolean(running);
    }
    createAudioContext(reason, restoreId) {
      const Ctor = root.AudioContext || root.webkitAudioContext;
      if (!Ctor) return null;
      this.audioContext = new Ctor();
      this.playback.setAudioContext(this.audioContext);
      const onStateChange = () => {
        this.recordEvent("audio_context_state_changed", { audio_context_state: String(this.audioContext && this.audioContext.state || ""), reason, restore_id: restoreId || "" });
        this.confirmAudioContextRunning("statechange");
      };
      if (typeof this.audioContext.addEventListener === "function") this.audioContext.addEventListener("statechange", onStateChange);
      else this.audioContext.onstatechange = onStateChange;
      if (restoreId) this.recordEvent("audio_context_recreated", { restore_id: restoreId, reason, audio_context_state: String(this.audioContext.state || "") });
      return this.audioContext;
    }
    setupVadRuntime(reason, restoreId) {
      this.stopVadRuntime(`${reason}_reset`);
      if (!this.audioContext || !this.stream) {
        this.microphoneReady = false;
        this.microphoneFailureReason = "vad_prerequisites_missing";
        return false;
      }
      try {
        this.vadAnalyser = this.audioContext.createAnalyser();
        this.vadAnalyser.fftSize = CONFIG.analyserFftSize;
        this.vadSource = this.audioContext.createMediaStreamSource(this.stream);
        this.vadSource.connect(this.vadAnalyser);
      } catch (error) {
        this.microphoneReady = false;
        this.microphoneFailureReason = "web_audio_capture_failed";
        this.recordEvent("microphone_start_failed", this.failureDetails(this.microphoneFailureReason, error, { restore_id: restoreId || "" }));
        return false;
      }
      this.startVadLoop(reason, restoreId);
      this.microphoneReady = this.microphoneReadyForRecording();
      this.microphoneFailureReason = this.microphoneReady ? "" : "microphone_stream_not_live";
      return this.microphoneReady;
    }
    stopVadRuntime(reason) {
      this.vadRunning = false;
      this.vadLoopToken += 1;
      this.voiceActive = false;
      this.silenceStartedAt = 0;
      if (this.vadSource && typeof this.vadSource.disconnect === "function") {
        try { this.vadSource.disconnect(); } catch (error) { this.trace("VAD Disconnect Failed", { reason, error_message: String(error && error.message || error || "") }); }
      }
      this.vadSource = null;
      this.vadAnalyser = null;
    }
    startVadLoop(reason, restoreId) {
      this.vadRunning = true;
      this.vadLoopToken += 1;
      const token = this.vadLoopToken;
      this.recordEvent("vad_loop_started", { reason, restore_id: restoreId || "", vad_loop_token: token });
      this.vadLoop(token);
    }
    readyAfterRestore() {
      return Boolean(
        this.socket
        && this.socket.readyState === WebSocket.OPEN
        && this.sessionReady
        && this.currentSessionId
        && this.mediaStreamActive()
        && this.audioContext
        && this.audioContext.state === "running"
        && this.microphoneReadyForRecording()
        && (!this.turn.mediaRecorder || this.turn.mediaRecorder.state !== "recording")
        && this.playback.activeSourceCount() === 0
        && this.playback.audioQueueLength() === 0
      );
    }
    finishForegroundRestoreReady(restoreId) {
      if (!this.postRestoreOwner || this.postRestoreOwner.restore_id !== restoreId || this.postRestoreOwner.socket_instance_id !== this.socketInstanceId || this.postRestoreOwner.session_id !== this.currentSessionId) {
        this.failLifecycleRestore("restore_owner_tuple_missing_or_changed", null, { restore_id: restoreId });
        return;
      }
      this.state.conversation_state = "listening";
      this.state.playback_state = "idle";
      this.state.listening_active = true;
      this.inputGate.set("open", "lifecycle_restore_ready", { restore_id: restoreId });
      this.recordEvent("input_gate_reopened", { restore_id: restoreId, success: true });
      this.awaitingPostRestoreTurn = true;
      this.postRestoreTurnId = "";
      this.postRestoreTurnCompleted = false;
      this.postRestoreRecordingOwner = null;
      this.postRestoreGenerationOwner = null;
      this.restoreNeeded = false;
      this.restoreInProgress = false;
      this.setLifecycleState("READY", "foreground_restore_ready", { restore_id: restoreId });
      this.recordEvent("lifecycle_restore_ready", { restore_id: restoreId, success: true, current_session_id: this.currentSessionId, socket_instance_id: this.socketInstanceId, session_id: this.currentSessionId, owner_tuple: ownerTupleKey(this.postRestoreOwner) });
      this.updateDiagnostics({ conversation_state: "listening", playback_state: "idle", listening_active: true });
    }
    failLifecycleRestore(blockedReason, error, extra) {
      this.restoreInProgress = false;
      this.state.listening_active = false;
      this.inputGate.set("closed", "lifecycle_restore_failed", { blocked_reason: blockedReason });
      this.setLifecycleState("FAILED", "foreground_restore_failed", { failure_reason: blockedReason, ...(extra || {}) });
      this.recordEvent("reconnect_failed", this.failureDetails(blockedReason, error, extra || {}));
      this.updateDiagnostics({ listening_active: false, lifecycle_failure_reason: blockedReason });
    }
    welcomeElementIdentity(audio) {
      if (!audio) return "missing";
      if (audio.id) return `id:${audio.id}`;
      return "configured_welcome_audio";
    }
    safeWelcomeMediaSnapshot(audio) {
      const error = audio && audio.error;
      return {
        welcome_element_id: this.welcomeElementIdentity(audio),
        welcome_src_path: safeUrlPath(audio && (audio.currentSrc || audio.src)),
        audio_error_code: error && typeof error.code !== "undefined" ? error.code : "",
        networkState: audio && typeof audio.networkState !== "undefined" ? audio.networkState : "",
        readyState: audio && typeof audio.readyState !== "undefined" ? audio.readyState : "",
        paused: audio && typeof audio.paused !== "undefined" ? Boolean(audio.paused) : "",
        currentTime: audio && typeof audio.currentTime !== "undefined" ? Number(audio.currentTime || 0) : "",
        duration: audio && typeof audio.duration !== "undefined" ? Number(audio.duration || 0) : ""
      };
    }
    registerWelcomeElement(audio, welcomeId) {
      const onPlaying = () => {
        if (!this.welcome.owns(welcomeId)) return;
        this.m2a.welcomePlaying = true;
        this.setPlaybackState("playing", "welcome_media_playing", { welcome_id: welcomeId });
        this.recordEvent("welcome_media_playing", { welcome_id: welcomeId, success: true, ...this.safeWelcomeMediaSnapshot(audio) });
        this.updateM2aDiagnostics();
      };
      const onEnded = () => {
        if (!this.welcome.owns(welcomeId)) return;
        this.recordEvent("welcome_media_ended", { welcome_id: welcomeId, success: true, ...this.safeWelcomeMediaSnapshot(audio) });
        this.startupInProgress = false;
        this.welcome.complete("html_audio_element", welcomeId);
      };
      const onError = () => {
        if (!this.welcome.owns(welcomeId)) return;
        this.m2a.welcomeErrored = true;
        this.m2a.failureReason = "welcome_media_error";
        this.recordEvent("welcome_media_error", { welcome_id: welcomeId, failure_reason: "media_error", ...this.safeWelcomeMediaSnapshot(audio) });
        this.startupInProgress = false;
        this.welcome.fail("local_welcome_asset_failed", welcomeId);
      };
      if (typeof audio.addEventListener === "function") {
        audio.addEventListener("playing", onPlaying, { once: true });
        audio.addEventListener("ended", onEnded, { once: true });
        audio.addEventListener("error", onError, { once: true });
      } else {
        audio.onplaying = onPlaying;
        audio.onended = onEnded;
        audio.onerror = onError;
      }
    }
    wsUrl() { return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/realtime`; }
    async start() {
      this.explicitSessionEpoch += 1;
      const sessionEpoch = this.explicitSessionEpoch;
      this.resetExplicitSessionState("explicit_session_start");
      this.startupInProgress = true;
      this.recordEvent("start_gesture_received", { success: true });
      this.state.conversation_state = "connecting_welcoming";
      this.inputGate.set("assistant_playing", "connect_clicked");
      this.updateDiagnostics({ conversation_state: "connecting_welcoming" });
      this.initiateAudioContextFromGesture(sessionEpoch);
      this.welcome.start();
      void this.connectWebSocket();
      await this.initializeAudio(sessionEpoch);
    }
    isCurrentExplicitSession(sessionEpoch) {
      return sessionEpoch === this.explicitSessionEpoch;
    }
    resetM2aState() {
      this.m2a = {
        audioContextRunningConfirmed: false,
        audioContextResumeResolved: false,
        audioContextResumeRejected: false,
        welcomePlayResolved: false,
        welcomePlayRejected: false,
        welcomePlaying: false,
        welcomeEnded: false,
        welcomeErrored: false,
        failureReason: ""
      };
    }
    resetExplicitSessionState(reason) {
      this.welcome.reset();
      this.turn.clearForLifecycle(reason, "");
      this.turn.turnCount = 0;
      this.stopVadRuntime(reason);
      this.playback.clearForLifecycle(reason, "");
      this.generation.reset();
      this.pendingBlobs = [];
      this.socketSessionReadyResolvers.forEach((pending) => {
        if (pending && typeof pending.reject === "function") pending.reject(new Error("explicit_session_reset"));
      });
      this.socketSessionReadyResolvers.clear();
      this.sessionReady = false;
      this.currentSessionId = "";
      this.socketInstanceId = "";
      this.stream = null;
      this.microphoneReady = false;
      this.microphoneFailureReason = "";
      this.firstTurnCompleted = false;
      this.lastCompletedTurnId = "";
      this.lastFailedTurnId = "";
      this.lastSuccessfulTranscript = "";
      this.recoverableEmptyTranscriptCount = 0;
      this.staleTurnFailureIgnoredCount = 0;
      this.sessionPcmReceivedTotal = 0;
      this.sessionPcmScheduledTotal = 0;
      this.sessionPcmPlayedTotal = 0;
      this.sessionPcmIgnoredTotal = 0;
      this.m2StartupCompleted = false;
      this.startupInProgress = false;
      this.lifecycleInterrupted = false;
      this.audioContextResumePromise = null;
      this.welcomePlayPromise = null;
      this.lifecycleState = "ACTIVE";
      this.restoreNeeded = false;
      this.restoreInProgress = false;
      this.restoreToken = "";
      this.postRestoreOwner = null;
      this.postRestoreRecordingOwner = null;
      this.postRestoreGenerationOwner = null;
      this.awaitingPostRestoreTurn = false;
      this.postRestoreTurnId = "";
      this.postRestoreTurnCompleted = false;
      this.state.conversation_state = "disconnected";
      this.state.playback_state = "idle";
      this.state.listening_active = false;
      this.state.websocket_connected = false;
      this.state.generation_completed = false;
      this.state.active_playback_generation_id = "";
      this.state.active_turn_id = "";
      this.state.last_assistant_playback_completed_at = 0;
      this.state.playback_scope = "";
      this.state.welcome_id = "";
      this.resetM2aState();
      this.inputGate.set("closed", reason);
      this.updateDiagnostics({
        welcome_started: false,
        welcome_completed: false,
        welcome_failed: false,
        welcome_failure_reason: "",
        session_id: "",
        current_session_id: "",
        socket_instance_id: "",
        turn_count: 0,
        asr_result: "not_started",
        localized_transcript: "",
        raw_assistant_text: "",
        normalized_assistant_text: "",
        display_text: "",
        tts_input_text: "",
        generation_completed: false,
        generation_completed_at: "",
        generation_terminal_event_type: "",
        generation_terminal_event_received_at: "",
        generation_terminal_generation_id: "",
        generation_completion_blockers: [],
        pcm_received: 0,
        pcm_scheduled: 0,
        pcm_played: 0,
        pcm_ignored: 0,
        generation_pcm_received: 0,
        generation_pcm_scheduled: 0,
        generation_pcm_played: 0,
        generation_pcm_ignored: 0,
        session_pcm_received_total: 0,
        session_pcm_scheduled_total: 0,
        session_pcm_played_total: 0,
        session_pcm_ignored_total: 0,
        pcm_ignored_reason_counts: { stale_generation: 0, missing_generation_id: 0, no_active_generation: 0, duplicate_chunk: 0 },
        active_playback_generation_id: "",
        active_turn_id: "",
        current_active_turn_id: "",
        audio_queue_length: 0,
        active_pcm_source_count: 0,
        pending_pcm_chunk_count: 0,
        pending_segment_count: 0,
        active_pcm_source_ids: [],
        pending_utterance_count: 0,
        microphone_ready: false,
        microphone_failure_reason: "",
        mic_stream_active: false,
        first_turn_completed: false,
        last_completed_turn_id: "",
        last_completed_turn_outcome: "",
        last_failed_turn_id: "",
        last_failed_turn_error_type: "",
        last_successful_transcript: "",
        last_empty_transcript_at: "",
        recoverable_empty_transcript_count: 0,
        stale_turn_failure_ignored_count: 0,
        m2_startup_completed: false,
        m2a_status: "not_started",
        m2a_local_acceptance_ready: false,
        audio_context_running_confirmed: false,
        welcome_play_resolved: false,
        welcome_media_playing: false,
        welcome_media_ended: false,
        lifecycle_interrupted: false,
        m2a_failure_reason: "",
        listening_active: false,
        conversation_state: "disconnected",
        playback_state: "idle"
      });
    }
    initiateAudioContextFromGesture(sessionEpoch) {
      this.recordEvent("audio_context_create_attempted", { success: true });
      const Ctor = root.AudioContext || root.webkitAudioContext;
      if (!Ctor) {
        this.m2a.failureReason = "audio_context_unavailable";
        this.recordEvent("audio_context_resume_rejected", { failure_reason: this.m2a.failureReason });
        this.updateM2aDiagnostics();
        return null;
      }
      if (!this.audioContext) {
        this.createAudioContext("start_gesture");
      }
      this.recordEvent("audio_context_resume_attempted", { audio_context_state: String(this.audioContext.state || "") });
      let resumePromise;
      try {
        resumePromise = this.audioContext.state === "suspended" && typeof this.audioContext.resume === "function"
          ? this.audioContext.resume()
          : Promise.resolve();
      } catch (error) {
        resumePromise = Promise.reject(error);
      }
      this.audioContextResumePromise = Promise.resolve(resumePromise).then(() => {
        if (sessionEpoch && !this.isCurrentExplicitSession(sessionEpoch)) return;
        this.m2a.audioContextResumeResolved = true;
        this.recordEvent("audio_context_resume_resolved", { success: true, audio_context_state: String(this.audioContext && this.audioContext.state || "") });
        this.confirmAudioContextRunning("resume_resolved");
      }).catch((error) => {
        if (sessionEpoch && !this.isCurrentExplicitSession(sessionEpoch)) return;
        this.m2a.audioContextResumeRejected = true;
        this.m2a.failureReason = "audio_context_resume_rejected";
        this.recordEvent("audio_context_resume_rejected", { failure_reason: "resume_promise_rejected", error_name: String(error && error.name || ""), error_message: String(error && error.message || error || ""), audio_context_state: String(this.audioContext && this.audioContext.state || "") });
        this.updateM2aDiagnostics();
      });
      return this.audioContext;
    }
    confirmAudioContextRunning(reason) {
      if (!this.audioContext || this.audioContext.state !== "running") {
        this.updateM2aDiagnostics();
        return false;
      }
      if (!this.m2a.audioContextRunningConfirmed) {
        this.m2a.audioContextRunningConfirmed = true;
        this.recordEvent("audio_context_running_confirmed", { success: true, reason, audio_context_state: "running" });
      }
      this.updateM2aDiagnostics();
      return true;
    }
    async initializeAudio(sessionEpoch) {
      const resolver = root.XiaoRuiAudioFormatResolver;
      const selected = resolver.selectSupportedMime(root.MediaRecorder);
      this.selectedMime = selected.selectedInputMime;
      this.recordEvent("microphone_start_attempted", { selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey });
      const nav = root.navigator || {};
      if (!nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== "function") {
        this.microphoneReady = false;
        this.microphoneFailureReason = "microphone_api_unavailable";
        this.recordEvent("microphone_api_unavailable", this.failureDetails("navigator_mediaDevices_getUserMedia_unavailable", null, { selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey }));
        this.recordEvent("microphone_start_failed", this.failureDetails("microphone_api_unavailable", null, { selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey }));
        this.updateDiagnostics({ mic_stream_active: false, microphone_ready: false, microphone_failure_reason: this.microphoneFailureReason, selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey });
        return false;
      }
      try {
        const stream = await nav.mediaDevices.getUserMedia(root.XiaoRuiRecorderAdapter.audioInputConstraints());
        if (sessionEpoch && !this.isCurrentExplicitSession(sessionEpoch)) {
          if (stream && typeof stream.getTracks === "function") stream.getTracks().forEach((track) => { if (track && typeof track.stop === "function") track.stop(); });
          return false;
        }
        this.stream = stream;
      } catch (error) {
        const denied = error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
        this.microphoneReady = false;
        this.microphoneFailureReason = denied ? "microphone_permission_denied" : "getUserMedia_rejected";
        if (denied) this.recordEvent("microphone_permission_denied", this.failureDetails("permission_denied", error, { selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey }));
        this.recordEvent("microphone_start_failed", this.failureDetails(this.microphoneFailureReason, error, { selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey }));
        this.updateDiagnostics({ mic_stream_active: false, microphone_ready: false, microphone_failure_reason: this.microphoneFailureReason, selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey });
        return false;
      }
      this.recordEvent("microphone_permission_granted", { success: true, selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey });
      if (!this.audioContext) this.initiateAudioContextFromGesture();
      if (this.audioContextResumePromise) await this.audioContextResumePromise;
      else this.confirmAudioContextRunning("initialize_audio");
      if (sessionEpoch && !this.isCurrentExplicitSession(sessionEpoch)) return false;
      this.playback.setAudioContext(this.audioContext);
      if (!this.audioContext) {
        this.microphoneReady = false;
        this.microphoneFailureReason = "audio_context_unavailable_for_microphone";
        this.recordEvent("microphone_start_failed", this.failureDetails(this.microphoneFailureReason, null, { selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey }));
        this.updateDiagnostics({ mic_stream_active: false, microphone_ready: false, microphone_failure_reason: this.microphoneFailureReason });
        return false;
      }
      try {
        this.setupVadRuntime("initialize_audio");
      } catch (error) {
        this.microphoneReady = false;
        this.microphoneFailureReason = "web_audio_capture_failed";
        this.recordEvent("microphone_start_failed", this.failureDetails(this.microphoneFailureReason, error, { selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey }));
        this.updateDiagnostics({ mic_stream_active: false, microphone_ready: false, microphone_failure_reason: this.microphoneFailureReason });
        return false;
      }
      this.microphoneReady = this.microphoneReadyForRecording();
      this.microphoneFailureReason = this.microphoneReady ? "" : "microphone_stream_not_live";
      if (this.microphoneReady) this.recordEvent("microphone_stream_started", { success: true, selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey, mic_stream_active: true });
      else this.recordEvent("microphone_start_failed", this.failureDetails(this.microphoneFailureReason, null, { selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey }));
      this.updateDiagnostics({ selected_mime: this.selectedMime, normalized_mime: selected.normalizedInputMime, converter_key: selected.converterKey, audio_context_state: this.audioContext.state, mic_stream_active: true });
      if (this.welcome.completed && this.sessionReady) this.openListening("microphone_ready");
      return this.microphoneReady;
    }
    connectWebSocket(options) {
      const connectOptions = options || {};
      const socketInstanceId = makeId("socket");
      this.socketInstanceCounter += 1;
      this.socketInstanceId = socketInstanceId;
      this.websocketCloseInitiator = "";
      const socket = new WebSocket(this.wsUrl());
      this.socket = socket;
      this.updateDiagnostics({ socket_instance_id: socketInstanceId, websocket_close_initiator: "" });
      if (connectOptions.lifecycleRestore) this.recordEvent("websocket_reconnect_attempted", { restore_id: connectOptions.restoreId || "", socket_instance_id: socketInstanceId, reconnect_attempt: this.restoreAttempt });
      let sessionReadyPromise = null;
      if (connectOptions.awaitSessionReady) {
        sessionReadyPromise = new Promise((resolve, reject) => {
          this.socketSessionReadyResolvers.set(socketInstanceId, { resolve, reject, restore_id: connectOptions.restoreId || "" });
        });
      }
      socket.addEventListener("open", () => {
        if (!this.isCurrentSocket(socket, socketInstanceId)) return;
        this.state.websocket_connected = true;
        this.updateDiagnostics({ websocket_connected: true });
        this.sendSocketPayload({ type: "client.session.start", role: "visitor", runtime_streaming_provider: "xiaomi_streaming" }, "client_session_start");
      });
      socket.addEventListener("message", (message) => {
        if (!this.isCurrentSocket(socket, socketInstanceId)) return;
        this.handleServerEvent(JSON.parse(message.data));
      });
      socket.addEventListener("error", () => {
        if (!this.isCurrentSocket(socket, socketInstanceId)) return;
        this.trace("WebSocket Error", { socket_instance_id: socketInstanceId });
      });
      socket.addEventListener("close", (event) => this.handleSocketClose(event, socketInstanceId, socket));
      return sessionReadyPromise || socket;
    }
    isCurrentSocket(socket, socketInstanceId) {
      return socket === this.socket && socketInstanceId === this.socketInstanceId;
    }
    sendSocketPayload(payload, stackHint) {
      this.lastClientEventBeforeClose = payload.type || "";
      this.updateDiagnostics({ last_client_event_before_close: this.lastClientEventBeforeClose });
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
      this.socket.send(JSON.stringify(payload));
      this.trace("Client Event Sent", { type: payload.type, stack_hint: stackHint || payload.type, socket_instance_id: this.socketInstanceId });
      return true;
    }
    handleSocketClose(event, socketInstanceId, socket) {
      if (!this.isCurrentSocket(socket, socketInstanceId)) {
        this.ignoredStaleSocketCloseCount += 1;
        this.updateDiagnostics({ ignored_stale_socket_close_count: this.ignoredStaleSocketCloseCount });
        this.trace("Stale WebSocket Close Ignored", { socket_instance_id: socketInstanceId, current_socket_instance_id: this.socketInstanceId });
        return;
      }
      const initiator = this.websocketCloseInitiator || "browser_or_backend";
      const code = event && typeof event.code !== "undefined" ? event.code : "";
      const reason = event && typeof event.reason !== "undefined" ? event.reason : "";
      this.state.websocket_connected = false;
      this.sessionReady = false;
      const pending = this.socketSessionReadyResolvers.get(socketInstanceId);
      if (pending) {
        this.socketSessionReadyResolvers.delete(socketInstanceId);
        pending.reject(new Error(`websocket_closed_${code || "unknown"}`));
      }
      this.socket = null;
      this.state.conversation_state = "disconnected";
      this.state.playback_state = "idle";
      this.state.listening_active = false;
      this.state.active_playback_generation_id = "";
      this.state.active_turn_id = "";
      this.inputGate.set("closed", "websocket_closed", { initiator, code, reason, socket_instance_id: socketInstanceId });
      this.updateDiagnostics({
        websocket_connected: false,
        websocket_close_initiator: initiator,
        websocket_close_code: code,
        websocket_close_reason: reason,
        websocket_close_timestamp: new Date().toISOString(),
        websocket_close_stack_hint: initiator,
        conversation_state: "disconnected",
        playback_state: "idle",
        active_playback_generation_id: "",
        active_turn_id: ""
      });
      this.trace("WebSocket Closed", { initiator, code, reason, socket_instance_id: socketInstanceId, last_server_event_before_close: this.lastServerEventBeforeClose, last_client_event_before_close: this.lastClientEventBeforeClose });
    }
    openListening(reason) {
      if (this.generation.generationId && !this.generation.generationCompleted) {
        this.generation.completeIfReady(`open_listening_${reason}`);
        if (!this.generation.generationCompleted) {
          this.state.conversation_state = "assistant_playing";
          this.state.playback_state = this.playback.hasPlaybackWork(this.generation.generationId) ? "playing" : "buffering";
          this.state.listening_active = false;
          if (this.inputGate.value !== "closed") this.inputGate.set("closed", "open_listening_blocked_active_generation", { reason, generation_id: this.generation.generationId });
          this.trace("Listening Open Blocked", { reason, generation_id: this.generation.generationId, blockers: this.generation.generationCompletionBlockers });
          this.updateDiagnostics(this.generation.diagnostics());
          return;
        }
      }
      const startupTransition = reason === "welcome_completed"
        || reason === "welcome_failed"
        || reason === "session_ready"
        || reason === "microphone_ready";
      const authoritativeSessionReady = Boolean(
        this.socket
        && this.socket.readyState === WebSocket.OPEN
        && this.sessionReady
        && this.currentSessionId
      );
      if (startupTransition && (!this.welcome.completed || !authoritativeSessionReady)) {
        this.state.conversation_state = "connecting_welcoming";
        this.state.playback_state = this.welcome.completed ? "idle" : this.state.playback_state;
        this.state.listening_active = false;
        this.inputGate.set("closed", "startup_prerequisites_pending", {
          reason,
          welcome_completed: this.welcome.completed,
          authoritative_session_ready: authoritativeSessionReady
        });
        this.updateDiagnostics({ listening_active: false, microphone_ready: this.microphoneReadyForRecording() });
        return;
      }
      this.state.conversation_state = "listening";
      this.state.playback_state = "idle";
      const microphoneReady = this.microphoneReadyForRecording();
      this.microphoneReady = microphoneReady;
      this.state.listening_active = microphoneReady;
      this.inputGate.set(microphoneReady || !startupTransition ? "open" : "closed", reason, { microphone_ready: microphoneReady });
      if (!microphoneReady) this.recordMicrophoneBlockedAfterWelcome(reason);
      if (microphoneReady) this.m2StartupCompleted = true;
      this.updateDiagnostics({ conversation_state: "listening", playback_state: "idle", listening_active: microphoneReady, websocket_connected: Boolean(this.state.websocket_connected), microphone_ready: microphoneReady });
      this.flushPendingBlobs();
    }
    energy() {
      if (!this.vadAnalyser) return 0;
      const data = new Uint8Array(this.vadAnalyser.fftSize);
      this.vadAnalyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) { const centered = (value - 128) / 128; sum += centered * centered; }
      return Math.sqrt(sum / data.length);
    }
    vadLoop(token) {
      if (!this.vadRunning || token !== this.vadLoopToken) return;
      const current = this.energy();
      const detected = current >= CONFIG.speechThreshold;
      const now = perfNow();
      const echoGuard = this.state.last_assistant_playback_completed_at && now - this.state.last_assistant_playback_completed_at < CONFIG.postPlaybackEchoGuardMs;
      if (this.inputGate.isOpen() && this.state.listening_active && !echoGuard) {
        if (detected && !this.voiceActive) {
          this.voiceActive = this.turn.beginRecording();
          this.silenceStartedAt = 0;
        } else if (!detected && this.voiceActive) {
          if (!this.silenceStartedAt) this.silenceStartedAt = now;
          if (now - this.silenceStartedAt >= CONFIG.silenceDurationMs) {
            this.voiceActive = false;
            this.turn.stopRecording();
          }
        } else if (detected) {
          this.silenceStartedAt = 0;
        }
      }
      root.requestAnimationFrame(() => this.vadLoop(token));
    }
    async sendVoiceBlob(blob, utteranceId, turnIndex, mime, owner) {
      if (owner && !this.ensurePostRestoreOwnerValid(owner, "post_restore_blob_owner_mismatch", { utterance_id: utteranceId, turn_index: turnIndex })) return;
      const audioB64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
        reader.readAsDataURL(blob);
      });
      const payload = { type: "client.voice.turn.start", utterance_id: utteranceId, turn_index: turnIndex, audio_b64: audioB64, mime_type: mime, audio_bytes_length: blob.size, local_session_welcome_completed: true };
      if (!this.sessionReady || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
        this.pendingBlobs.push({ payload, owner: cloneOwnerTuple(owner) });
        this.recordEvent("audio_chunk_send_queued", { utterance_id: utteranceId, turn_index: turnIndex, blob_size: blob.size, mime_type: mime, recorder_mime_type: mime, pending_utterance_count: this.pendingBlobs.length, blocked_reason: "websocket_or_session_not_ready" });
        this.updateDiagnostics({ pending_utterance_count: this.pendingBlobs.length });
        return;
      }
      if (owner && !this.ensurePostRestoreOwnerValid(owner, "post_restore_blob_send_owner_mismatch", { utterance_id: utteranceId, turn_index: turnIndex })) return;
      this.state.conversation_state = "understanding";
      this.state.listening_active = false;
      this.inputGate.set("committed_processing", "blob_sent", { utterance_id: utteranceId });
      const sent = this.sendSocketPayload(payload, "voice_turn_blob_sent");
      if (sent) this.recordEvent("audio_chunk_sent", { utterance_id: utteranceId, turn_index: turnIndex, blob_size: blob.size, mime_type: mime, recorder_mime_type: mime, success: true });
      else this.recordEvent("audio_chunk_send_failed", this.failureDetails("websocket_send_failed", null, { utterance_id: utteranceId, turn_index: turnIndex, blob_size: blob.size, mime_type: mime, recorder_mime_type: mime }));
      if (sent) this.recordPostRestoreAudioSent(utteranceId, turnIndex, blob.size, mime);
      this.trace("Blob Sent", { utterance_id: utteranceId, turn_index: turnIndex, mime_type: mime });
    }
    flushPendingBlobs() {
      if (!this.sessionReady || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      const pending = this.pendingBlobs.splice(0);
      pending.forEach((entry) => {
        const envelope = entry && entry.payload ? entry : { payload: entry, owner: null };
        if (envelope.owner && !this.ensurePostRestoreOwnerValid(envelope.owner, "pending_blob_owner_mismatch", { utterance_id: envelope.payload.utterance_id || "", turn_index: envelope.payload.turn_index || 0 })) return;
        const sent = this.sendSocketPayload(envelope.payload, "flush_pending_blob");
        if (sent) this.recordEvent("audio_chunk_sent", { utterance_id: envelope.payload.utterance_id || "", turn_index: envelope.payload.turn_index || 0, blob_size: envelope.payload.audio_bytes_length || 0, mime_type: envelope.payload.mime_type || "", recorder_mime_type: envelope.payload.mime_type || "", success: true, flushed: true });
        else this.recordEvent("audio_chunk_send_failed", this.failureDetails("flush_pending_blob_failed", null, { utterance_id: envelope.payload.utterance_id || "", turn_index: envelope.payload.turn_index || 0, blob_size: envelope.payload.audio_bytes_length || 0, mime_type: envelope.payload.mime_type || "", recorder_mime_type: envelope.payload.mime_type || "" }));
      });
      this.updateDiagnostics({ pending_utterance_count: this.pendingBlobs.length });
    }
    sessionIdentityDetails(event, stackHint) {
      const metadata = event.metadata || {};
      const session = event.session || {};
      const incomingSessionId = session.session_id || metadata.session_id || "";
      const runtimeProvider = session.runtime_streaming_provider || metadata.runtime_streaming_provider || "";
      const pending = this.socketSessionReadyResolvers.get(this.socketInstanceId) || null;
      return {
        server_event_type: event.type || "",
        incoming_session_id: incomingSessionId,
        previous_session_id: this.currentSessionId || "",
        current_session_id: this.currentSessionId || "",
        session_id: incomingSessionId,
        socket_instance_id: this.socketInstanceId || "",
        restore_id: pending ? pending.restore_id || "" : this.postRestoreOwner ? this.postRestoreOwner.restore_id || "" : "",
        runtime_streaming_provider: runtimeProvider,
        stack_hint: stackHint || "server_session_created"
      };
    }
    isAuthoritativeRestoreSession(event) {
      const metadata = event.metadata || {};
      const session = event.session || {};
      const runtimeProvider = session.runtime_streaming_provider || metadata.runtime_streaming_provider || "";
      return runtimeProvider === "xiaomi_streaming";
    }
    acceptSessionIdentity(event, details, stackHint) {
      this.sessionReady = true;
      this.currentSessionId = details.incoming_session_id || "";
      this.state.websocket_connected = true;
      this.recordEvent("session_identity_accepted", {
        ...details,
        current_session_id: this.currentSessionId,
        success: true,
        stack_hint: stackHint || details.stack_hint || "session_identity_accepted"
      });
      this.updateDiagnostics({ websocket_connected: true, provider: "xiaomi", session_id: this.currentSessionId, current_session_id: this.currentSessionId });
      if (this.welcome.completed) this.openListening("session_ready");
    }
    handleServerEvent(event) {
      const type = event.type;
      const metadata = event.metadata || {};
      this.lastServerEventBeforeClose = type || "";
      this.updateDiagnostics({ last_server_event_before_close: this.lastServerEventBeforeClose });
      if (type === "server.session.created") {
        const pending = this.socketSessionReadyResolvers.get(this.socketInstanceId);
        const details = this.sessionIdentityDetails(event, pending ? "pending_restore_session_created" : "server_session_created");
        const authoritative = this.isAuthoritativeRestoreSession(event);
        this.recordEvent("session_identity_event_received", { ...details, authoritative_session_ready: authoritative });
        if (pending && !authoritative) {
          this.recordEvent("session_identity_non_authoritative", { ...details, blocked_reason: "restore_waiting_for_authoritative_xiaomi_session", authoritative_session_ready: false });
          this.state.websocket_connected = true;
          this.updateDiagnostics({ websocket_connected: true });
          return;
        }
        if (!this.postRestoreOwner && !authoritative) {
          this.recordEvent("session_identity_non_authoritative", { ...details, blocked_reason: "startup_waiting_for_authoritative_xiaomi_session", authoritative_session_ready: false });
          this.state.websocket_connected = true;
          this.updateDiagnostics({ websocket_connected: true });
          return;
        }
        if (this.postRestoreOwner && !pending) {
          if (details.incoming_session_id === this.currentSessionId) {
            this.recordEvent("session_identity_duplicate_ignored", { ...details, success: true, owner_tuple: ownerTupleKey(this.postRestoreOwner) });
            return;
          }
          if (!authoritative) {
            this.recordEvent("session_identity_late_non_authoritative_ignored", { ...details, blocked_reason: "post_restore_owner_already_established", owner_tuple: ownerTupleKey(this.postRestoreOwner), authoritative_session_ready: false });
            return;
          }
          this.handlePostRestoreOwnerMismatch("post_restore_session_changed", this.postRestoreOwner, this.captureOwnerTuple(this.postRestoreOwner.restore_id || "", this.socketInstanceId, details.incoming_session_id), {
            ...details,
            blocked_reason: "post_restore_session_changed",
            expected_session_id: this.currentSessionId || "",
            actual_session_id: details.incoming_session_id || ""
          });
          return;
        }
        this.acceptSessionIdentity(event, details, pending ? "authoritative_restore_session_ready" : "server_session_created");
        if (pending) {
          this.socketSessionReadyResolvers.delete(this.socketInstanceId);
          this.postRestoreOwner = this.captureOwnerTuple(pending.restore_id || "", this.socketInstanceId, this.currentSessionId);
          this.recordEvent("new_session_ready", { restore_id: pending.restore_id || "", success: true, current_session_id: this.currentSessionId, socket_instance_id: this.socketInstanceId, session_id: this.currentSessionId, owner_tuple: ownerTupleKey(this.postRestoreOwner) });
          this.recordEvent("websocket_reconnected", { restore_id: pending.restore_id || "", success: true, current_session_id: this.currentSessionId, socket_instance_id: this.socketInstanceId });
          pending.resolve({ session_id: this.currentSessionId, socket_instance_id: this.socketInstanceId });
        }
        this.flushPendingBlobs();
      } else if (type === "server.session.closed") {
        this.websocketCloseInitiator = "backend_session_closed";
        this.handleSocketClose({ code: "server.session.closed", reason: "server_session_closed" }, this.socketInstanceId, this.socket);
      } else if (type === "server.asr.started") {
        this.recordEvent("asr_started", { success: true, utterance_id: metadata.utterance_id || metadata.utteranceId || this.state.active_turn_id || "" });
        this.updateDiagnostics({ asr_result: "started" });
      } else if (type === "server.asr.final") {
        this.lastSuccessfulTranscript = event.text || "";
        this.recordEvent("asr_result_received", { success: true, asr_result: "final", utterance_id: metadata.utterance_id || metadata.utteranceId || this.state.active_turn_id || "" });
        this.recordPostRestoreAsrReceived(metadata.utterance_id || metadata.utteranceId || this.state.active_turn_id || "");
        this.updateDiagnostics({ asr_result: "final", localized_transcript: event.text || "", last_successful_transcript: this.lastSuccessfulTranscript });
      } else if (type === "server.asr.failed" || type === "server.asr.unavailable") {
        this.recordEvent("asr_result_received", this.failureDetails(metadata.error_type || type, null, { asr_result: type === "server.asr.failed" ? "failed" : "unavailable", utterance_id: metadata.utterance_id || metadata.utteranceId || this.state.active_turn_id || "" }));
        this.state.conversation_state = "error";
        this.state.playback_state = "idle";
        this.inputGate.set("closed", "server_error");
        this.updateDiagnostics({ conversation_state: "error", playback_state: "idle", asr_result: type === "server.asr.failed" ? "failed" : "unavailable", error_type: metadata.error_type || type });
      } else if (type === "server.generation.started") {
        if (this.awaitingPostRestoreTurn && this.postRestoreTurnId && this.turn.currentUtteranceId === this.postRestoreTurnId) {
          if (!this.ensurePostRestoreOwnerValid(this.postRestoreRecordingOwner || this.postRestoreOwner, "post_restore_generation_started_owner_mismatch", { utterance_id: this.postRestoreTurnId })) return;
          this.postRestoreGenerationOwner = cloneOwnerTuple(this.postRestoreRecordingOwner || this.postRestoreOwner);
        }
        this.generation.start(metadata.generation_id || event.generation_id, this.turn.currentUtteranceId);
        this.recordPostRestoreGenerationStarted(metadata.generation_id || event.generation_id || "", this.turn.currentUtteranceId);
      } else if (type === "server.text.delta.live" || type === "server.text.delta.placeholder") {
        const text = event.delta || metadata.delta || "";
        this.diagnostics.display_text += text;
        this.diagnostics.normalized_assistant_text += text;
        this.updateDiagnostics({ display_text: this.diagnostics.display_text, normalized_assistant_text: this.diagnostics.normalized_assistant_text });
      } else if (type === "server.text.done.live" || type === "server.text.done.placeholder" || type === "server.generation.completed") {
        if (metadata.raw_assistant_text) this.diagnostics.raw_assistant_text = metadata.raw_assistant_text;
        if (metadata.normalized_assistant_text) this.diagnostics.normalized_assistant_text = metadata.normalized_assistant_text;
        this.updateDiagnostics({ raw_assistant_text: this.diagnostics.raw_assistant_text || this.diagnostics.normalized_assistant_text, normalized_assistant_text: this.diagnostics.normalized_assistant_text, display_text: this.diagnostics.normalized_assistant_text });
      } else if (type === "server.audio.chunk") {
        this.diagnostics.tts_input_text = this.diagnostics.normalized_assistant_text;
        this.playback.scheduleChunk(event);
      } else if (type === "server.audio.stream.completed") {
        this.generation.segmentCompleted(event);
        this.updateDiagnostics(this.generation.diagnostics());
      } else if (type === "server.voice.turn.failed") {
        this.handleVoiceTurnFailed(event);
      } else {
        const terminal = normalizeServerTerminalEvent(type, event, this.state.active_playback_generation_id || this.generation.generationId || "");
        if (terminal.isGenerationAudioTerminal) {
          if (this.generation.markServerAudioEnd(event, terminal)) {
            this.generation.completeIfReady(terminal.sourceEventType);
          }
          this.updateDiagnostics(this.generation.diagnostics());
        } else if (type === "server.generation.failed" || type === "server.tts.failed") {
          this.state.conversation_state = "error";
          this.state.playback_state = "idle";
          this.inputGate.set("closed", "server_error");
          this.updateDiagnostics({ conversation_state: "error", playback_state: "idle", error_type: metadata.error_type || type });
        }
      }
    }
    handleVoiceTurnFailed(event) {
      const classification = classifyVoiceTurnFailure(event);
      if (classification === "recoverable_empty_transcript") {
        this.turn.completeEmptyTranscript(event);
        return;
      }
      this.turn.fail(event);
    }    stop() {
      this.explicitSessionEpoch += 1;
      this.websocketCloseInitiator = "user_stop";
      const socket = this.socket;
      if (socket && socket.readyState === WebSocket.OPEN) this.sendSocketPayload({ type: "client.session.close" }, "stop_conversation");
      this.socket = null;
      if (socket && typeof socket.close === "function") socket.close();
      if (this.stream && typeof this.stream.getTracks === "function") this.stream.getTracks().forEach((track) => { if (track && typeof track.stop === "function") track.stop(); });
      const welcomeAudio = this.welcomeAudio;
      if (welcomeAudio && typeof welcomeAudio.pause === "function") {
        try { welcomeAudio.pause(); } catch (error) { this.trace("Welcome Audio Stop Failed", { error_message: String(error && error.message || error || "") }); }
      }
      if (welcomeAudio && typeof welcomeAudio.currentTime === "number") {
        try { welcomeAudio.currentTime = 0; } catch (error) { this.trace("Welcome Audio Rewind Failed", { error_message: String(error && error.message || error || "") }); }
      }
      this.resetExplicitSessionState("stop_conversation");
      this.updateDiagnostics({ conversation_state: "disconnected", playback_state: "idle", websocket_close_initiator: "user_stop" });
    }
  }

  const api = Object.freeze({ CONFIG, GenerationController, InputGateController, PlaybackController, RebuildRealtimeApp, SessionWelcomeController, TurnController, base64ToBytes, normalizeServerTerminalEvent, classifyVoiceTurnFailure });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.XiaoRuiRealtimeVerticalSlice = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
