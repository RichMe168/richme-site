(function attachDeviceAudioEnvironment(root) {
  "use strict";

  function detectPlatformClass(userAgent) {
    const value = String(userAgent || "").toLowerCase();
    if (/android|iphone|ipad|ipod|mobile/.test(value)) return "mobile";
    if (/windows|macintosh|linux|x11/.test(value)) return "desktop";
    return "unknown";
  }

  function detectBrowserClass(userAgent) {
    const value = String(userAgent || "").toLowerCase();
    if (/edg\//.test(value)) return "edge_chromium";
    if (/crios|chrome|chromium/.test(value)) return "chromium";
    if (/firefox|fxios/.test(value)) return "firefox";
    if (/safari/.test(value) && !/chrome|chromium|crios|edg\//.test(value)) return "safari";
    if (/applewebkit/.test(value)) return "webkit";
    return "unknown";
  }

  function requiresUserGesture(userAgent) {
    const platform = detectPlatformClass(userAgent);
    const browser = detectBrowserClass(userAgent);
    return platform === "mobile" || browser === "safari" || browser === "webkit";
  }

  function buildDeviceAudioCapabilities(options) {
    const source = options || {};
    const userAgent = source.userAgent || "";
    const selectedInputMime = source.selectedInputMime || "";
    const resolver = source.formatResolver || root.XiaoRuiAudioFormatResolver;
    const normalizedInputMime = resolver ? resolver.normalizeAudioMimeType(selectedInputMime) : "application/octet-stream";
    const converterKey = resolver ? resolver.converterKeyForMime(selectedInputMime) : "";
    return {
      platform_class: detectPlatformClass(userAgent),
      browser_class: detectBrowserClass(userAgent),
      requires_user_gesture: requiresUserGesture(userAgent),
      selected_input_mime: selectedInputMime,
      normalized_input_mime: normalizedInputMime,
      converter_key: converterKey,
      microphone_ready: Boolean(source.microphoneReady),
      audio_context_ready: Boolean(source.audioContextReady),
      playback_ready: Boolean(source.playbackReady)
    };
  }

  const api = Object.freeze({
    buildDeviceAudioCapabilities,
    detectBrowserClass,
    detectPlatformClass,
    requiresUserGesture
  });

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.XiaoRuiDeviceAudioEnvironment = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
