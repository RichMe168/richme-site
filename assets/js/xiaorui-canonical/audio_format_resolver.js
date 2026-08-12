(function attachAudioFormatResolver(root) {
  "use strict";

  const RECORDER_MIME_CANDIDATES = Object.freeze([
    "audio/webm;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/x-m4a",
    "audio/ogg;codecs=opus"
  ]);

  const AUDIO_FORMAT_EXTENSIONS = Object.freeze({
    "audio/webm": "webm",
    "audio/mp4": "mp4",
    "audio/x-m4a": "m4a",
    "audio/m4a": "m4a",
    "audio/ogg": "ogg"
  });

  function normalizeAudioMimeType(rawMimeType) {
    const value = String(rawMimeType || "").trim().toLowerCase();
    if (!value) return "application/octet-stream";
    const base = value.split(";", 1)[0].trim();
    return base || "application/octet-stream";
  }

  function converterKeyForMime(rawMimeType) {
    return AUDIO_FORMAT_EXTENSIONS[normalizeAudioMimeType(rawMimeType)] || "";
  }

  function selectSupportedMime(mediaRecorderApi, candidates) {
    const candidateList = Array.isArray(candidates) && candidates.length ? candidates : RECORDER_MIME_CANDIDATES;
    const isSupported = mediaRecorderApi && typeof mediaRecorderApi.isTypeSupported === "function"
      ? mediaRecorderApi.isTypeSupported.bind(mediaRecorderApi)
      : null;
    const supported = isSupported ? candidateList.filter((mimeType) => isSupported(mimeType)) : [];
    const selected = supported[0] || "";
    return {
      supportedMimeCandidates: supported,
      selectedInputMime: selected,
      normalizedInputMime: normalizeAudioMimeType(selected),
      converterKey: converterKeyForMime(selected),
      inferred: false
    };
  }

  function resolvePayloadMime(details) {
    const source = details || {};
    const observed = String(source.mediaRecorderMimeType || source.blobType || "").trim();
    const fallback = String(source.selectedMime || "").trim();
    const payloadMime = observed || fallback;
    return {
      payloadMime,
      normalizedInputMime: normalizeAudioMimeType(payloadMime),
      converterKey: converterKeyForMime(payloadMime),
      inferred: !observed && Boolean(fallback)
    };
  }

  const api = Object.freeze({
    AUDIO_FORMAT_EXTENSIONS,
    RECORDER_MIME_CANDIDATES,
    converterKeyForMime,
    normalizeAudioMimeType,
    resolvePayloadMime,
    selectSupportedMime
  });

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.XiaoRuiAudioFormatResolver = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
