export const SPIKE_HARNESS = String.raw`
(function () {
  if (window.__bbSpike) return;
  var post = function (payload) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    } catch (error) {
      // A page navigation can tear the bridge down mid-report.
    }
  };
  var marks = {};
  window.__bbSpike = {
    post: post,
    mark: function (name) {
      marks[name] = Math.round(performance.now());
      post({ kind: "mark", name: name, atMs: marks[name] });
    },
    marks: marks,
  };
  window.addEventListener("error", function (event) {
    post({ kind: "page-error", message: String(event.message) });
  });
  window.addEventListener("unhandledrejection", function (event) {
    post({ kind: "page-error", message: "unhandled rejection: " + String(event.reason) });
  });
  document.addEventListener("DOMContentLoaded", function () {
    window.__bbSpike.mark("domContentLoaded");
  });
  window.addEventListener("load", function () {
    window.__bbSpike.mark("load");
  });
  window.__bbSpike.mark("harnessInstalled");
})();
true;
`;

export const BOOT_TIMING_PROBE = String.raw`
(function () {
  if (window.__bbBootWatch) return;
  window.__bbBootWatch = true;
  var post = window.__bbSpike.post;
  var startedAt = performance.now();
  var reportedFirstContent = false;
  var reportedInteractive = false;

  var interactiveSelectors = [
    "[data-testid='promptbox-textarea']",
    "textarea",
    "[contenteditable='true']",
    "input[type='password']",
    "input[type='email']",
    "button",
  ];

  var resourceTotals = function () {
    var entries = performance.getEntriesByType("resource");
    var transferred = 0;
    var decoded = 0;
    var scripts = 0;
    var scriptTransferred = 0;
    for (var i = 0; i < entries.length; i += 1) {
      transferred += entries[i].transferSize || 0;
      decoded += entries[i].decodedBodySize || 0;
      if (entries[i].initiatorType === "script" || /\.js(\?|$)/.test(entries[i].name)) {
        scripts += 1;
        scriptTransferred += entries[i].transferSize || 0;
      }
    }
    return {
      requests: entries.length,
      transferBytes: transferred,
      decodedBytes: decoded,
      scriptRequests: scripts,
      scriptTransferBytes: scriptTransferred,
    };
  };

  var navigationTiming = function () {
    var nav = performance.getEntriesByType("navigation")[0];
    if (!nav) return null;
    return {
      responseStartMs: Math.round(nav.responseStart),
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
      loadEventMs: Math.round(nav.loadEventEnd),
      documentTransferBytes: nav.transferSize || 0,
    };
  };

  var paintTiming = function () {
    var paints = performance.getEntriesByType("paint");
    var out = {};
    for (var i = 0; i < paints.length; i += 1) {
      out[paints[i].name] = Math.round(paints[i].startTime);
    }
    return out;
  };

  var check = function () {
    var root = document.getElementById("root");
    if (!reportedFirstContent && root && root.childElementCount > 0) {
      reportedFirstContent = true;
      post({ kind: "boot", phase: "rootContent", atMs: Math.round(performance.now()) });
    }
    if (!reportedInteractive) {
      for (var i = 0; i < interactiveSelectors.length; i += 1) {
        var found = document.querySelector(interactiveSelectors[i]);
        if (found) {
          reportedInteractive = true;
          post({
            kind: "boot",
            phase: "interactive",
            atMs: Math.round(performance.now()),
            matched: interactiveSelectors[i],
            title: document.title,
            url: location.href,
            navigation: navigationTiming(),
            paint: paintTiming(),
            resources: resourceTotals(),
          });
          break;
        }
      }
    }
    if (reportedInteractive) {
      // One settled report a second later catches the lazy chunks the first
      // interactive frame did not need.
      setTimeout(function () {
        post({
          kind: "boot",
          phase: "settled",
          atMs: Math.round(performance.now()),
          navigation: navigationTiming(),
          paint: paintTiming(),
          resources: resourceTotals(),
        });
      }, 1500);
      return;
    }
    if (performance.now() - startedAt > 60000) {
      post({ kind: "boot", phase: "timeout", atMs: Math.round(performance.now()) });
      return;
    }
    requestAnimationFrame(check);
  };
  check();
})();
true;
`;

export const ENVIRONMENT_PROBE = String.raw`
(function () {
  var mediaRecorderTypes = [];
  if (typeof MediaRecorder !== "undefined") {
    var candidates = ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg", "audio/aac"];
    for (var i = 0; i < candidates.length; i += 1) {
      if (MediaRecorder.isTypeSupported(candidates[i])) mediaRecorderTypes.push(candidates[i]);
    }
  }
  var canvas = document.createElement("canvas");
  var webgl2 = null;
  var webgl1 = null;
  try { webgl2 = canvas.getContext("webgl2"); } catch (error) { webgl2 = null; }
  try { webgl1 = canvas.getContext("webgl"); } catch (error) { webgl1 = null; }
  window.__bbSpike.post({
    kind: "environment",
    url: location.href,
    origin: location.origin,
    isSecureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    hasMediaDevices: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    hasMediaRecorder: typeof MediaRecorder !== "undefined",
    mediaRecorderTypes: mediaRecorderTypes,
    hasAsyncClipboard: Boolean(navigator.clipboard && navigator.clipboard.writeText),
    hasExecCommand: typeof document.execCommand === "function",
    hasWebSocket: typeof WebSocket !== "undefined",
    hasWakeLock: "wakeLock" in navigator,
    hasVisualViewport: Boolean(window.visualViewport),
    hasServiceWorker: "serviceWorker" in navigator,
    webgl2: Boolean(webgl2),
    webgl1: Boolean(webgl1),
    devicePixelRatio: window.devicePixelRatio,
    innerHeight: window.innerHeight,
    visualViewportHeight: window.visualViewport ? Math.round(window.visualViewport.height) : null,
  });
})();
true;
`;

export const VOICE_PROBE = String.raw`
(function () {
  var post = window.__bbSpike.post;
  var step = "getUserMedia";
  var startedAt = performance.now();
  post({ kind: "voice", step: "start" });
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    post({
      kind: "voice",
      step: "getUserMedia",
      ok: true,
      promptDelayMs: Math.round(performance.now() - startedAt),
      tracks: stream.getAudioTracks().map(function (track) {
        return { label: track.label, enabled: track.enabled, muted: track.muted, state: track.readyState };
      }),
    });
    step = "MediaRecorder";
    var preferred = null;
    var candidates = ["audio/webm", "audio/mp4", "audio/ogg"];
    for (var i = 0; i < candidates.length; i += 1) {
      if (MediaRecorder.isTypeSupported(candidates[i])) { preferred = candidates[i]; break; }
    }
    var recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
    var chunks = [];
    recorder.ondataavailable = function (event) { if (event.data.size > 0) chunks.push(event.data); };
    recorder.onerror = function (event) {
      post({ kind: "voice", step: "MediaRecorder", ok: false, error: String(event.error) });
    };
    recorder.onstop = function () {
      stream.getTracks().forEach(function (track) { track.stop(); });
      var blob = new Blob(chunks, { type: recorder.mimeType || preferred || "audio/webm" });
      post({
        kind: "voice",
        step: "MediaRecorder",
        ok: true,
        chunks: chunks.length,
        mimeType: recorder.mimeType,
        preferredMimeType: preferred,
        blobBytes: blob.size,
      });
      if (blob.size === 0) return;
      var extension = blob.type.indexOf("mp4") >= 0 ? "mp4" : blob.type.indexOf("ogg") >= 0 ? "ogg" : "webm";
      var file = new File([blob], "recording." + extension, { type: blob.type });
      var body = new FormData();
      body.append("file", file);
      var uploadStartedAt = performance.now();
      fetch("/api/v1/system/voice-transcription", { method: "POST", body: body, credentials: "include" })
        .then(function (response) {
          return response.text().then(function (text) {
            post({
              kind: "voice",
              step: "upload",
              ok: response.ok,
              status: response.status,
              uploadMs: Math.round(performance.now() - uploadStartedAt),
              body: text.slice(0, 400),
            });
          });
        })
        .catch(function (error) {
          post({ kind: "voice", step: "upload", ok: false, error: String(error) });
        });
    };
    recorder.start(250);
    setTimeout(function () { recorder.stop(); }, 3000);
  }).catch(function (error) {
    post({ kind: "voice", step: step, ok: false, error: error.name + ": " + error.message });
  });
})();
true;
`;

export const VOICE_EXPORT_PROBE = String.raw`
(function () {
  var post = window.__bbSpike.post;
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    var preferred = null;
    var candidates = ["audio/webm", "audio/mp4", "audio/ogg"];
    for (var i = 0; i < candidates.length; i += 1) {
      if (MediaRecorder.isTypeSupported(candidates[i])) { preferred = candidates[i]; break; }
    }
    var recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
    var chunks = [];
    recorder.ondataavailable = function (event) { if (event.data.size > 0) chunks.push(event.data); };
    recorder.onstop = function () {
      stream.getTracks().forEach(function (track) { track.stop(); });
      var blob = new Blob(chunks, { type: recorder.mimeType });
      fetch("http://localhost:9977/audio", { method: "POST", body: blob, headers: { "content-type": blob.type } })
        .then(function (response) {
          post({ kind: "voice-export", ok: response.ok, bytes: blob.size, mimeType: blob.type });
        })
        .catch(function (error) {
          post({ kind: "voice-export", ok: false, error: String(error) });
        });
    };
    recorder.start(250);
    setTimeout(function () { recorder.stop(); }, 3000);
  }).catch(function (error) {
    post({ kind: "voice-export", ok: false, error: String(error) });
  });
})();
true;
`;

export const VOICE_APP_PROBE = String.raw`
(function () {
  var post = window.__bbSpike.post;
  if (!window.__bbFetchPatched) {
    window.__bbFetchPatched = true;
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.indexOf("voice-transcription") >= 0) {
        var body = init && init.body;
        var describedBody = "none";
        if (body instanceof FormData) {
          var parts = [];
          body.forEach(function (value, key) {
            parts.push(key + "=" + (value instanceof File ? value.name + ":" + value.type + ":" + value.size + "B" : String(value).slice(0, 40)));
          });
          describedBody = parts.join(" ");
        }
        post({ kind: "voice-app", step: "request", url: url, body: describedBody });
        var startedAt = performance.now();
        return originalFetch.apply(this, arguments).then(function (response) {
          var clone = response.clone();
          clone.text().then(function (text) {
            post({ kind: "voice-app", step: "response", status: response.status, ms: Math.round(performance.now() - startedAt), body: text.slice(0, 300) });
          });
          return response;
        });
      }
      return originalFetch.apply(this, arguments);
    };
  }

  var press = function (element) {
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (type) {
      element.dispatchEvent(new (type.indexOf("pointer") === 0 ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true }));
    });
  };

  var start = document.querySelector('[aria-label="Start voice input"]');
  if (!start) {
    post({ kind: "voice-app", step: "start", ok: false, error: "no mic button" });
    return;
  }
  press(start);
  post({ kind: "voice-app", step: "start", ok: true });

  setTimeout(function () {
    var recording = document.querySelector('[aria-label="Cancel recording"]');
    post({ kind: "voice-app", step: "recordingUi", visible: Boolean(recording) });
  }, 700);

  setTimeout(function () {
    var stop = document.querySelector('[aria-label="Stop and transcribe recording"]');
    if (!stop) {
      post({ kind: "voice-app", step: "stop", ok: false, error: "no stop button" });
      return;
    }
    press(stop);
    post({ kind: "voice-app", step: "stop", ok: true });
  }, 3200);

  setTimeout(function () {
    var editor = document.querySelector("textarea, [contenteditable='true']");
    post({
      kind: "voice-app",
      step: "settled",
      composerValue: editor ? (editor.value !== undefined ? editor.value : editor.textContent).slice(0, 200) : null,
      stillRecording: Boolean(document.querySelector('[aria-label="Cancel recording"]')),
      toast: (function () {
        var toast = document.querySelector("[data-sonner-toast]");
        return toast ? toast.textContent.slice(0, 200) : null;
      })(),
    });
  }, 8000);
})();
true;
`;

export const VOICE_UI_PROBE = String.raw`
(function () {
  var post = window.__bbSpike.post;
  var buttons = Array.prototype.slice.call(document.querySelectorAll("button"));
  var mic = buttons.filter(function (button) {
    var label = (button.getAttribute("aria-label") || button.title || "").toLowerCase();
    return label.indexOf("voice") >= 0 || label.indexOf("record") >= 0 || label.indexOf("dictat") >= 0 || label.indexOf("microphone") >= 0;
  });
  post({
    kind: "voice-ui",
    micButtons: mic.map(function (button) {
      var rect = button.getBoundingClientRect();
      return {
        label: button.getAttribute("aria-label") || button.title,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        visible: rect.width > 0 && rect.height > 0,
      };
    }),
    buttonCount: buttons.length,
  });
})();
true;
`;

export const CLIPBOARD_PROBE = String.raw`
(function () {
  var post = window.__bbSpike.post;
  var sample = "bb-clipboard-probe-" + Math.round(performance.now());
  var execCommandResult = null;
  try {
    var textarea = document.createElement("textarea");
    textarea.value = sample;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    execCommandResult = document.execCommand("copy");
    textarea.remove();
  } catch (error) {
    execCommandResult = "threw: " + String(error);
  }
  var finish = function (asyncResult) {
    post({
      kind: "clipboard",
      isSecureContext: window.isSecureContext,
      hasAsyncClipboard: Boolean(navigator.clipboard && navigator.clipboard.writeText),
      asyncWrite: asyncResult,
      execCommandCopy: execCommandResult,
    });
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(sample).then(function () { finish("ok"); },
      function (error) { finish("rejected: " + String(error)); });
  } else {
    finish("absent");
  }
})();
true;
`;

export const WEBSOCKET_PROBE = String.raw`
(function () {
  var post = window.__bbSpike.post;
  var url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  var startedAt = performance.now();
  var socket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    post({ kind: "websocket", ok: false, url: url, error: String(error) });
    return;
  }
  socket.onopen = function () {
    post({ kind: "websocket", ok: true, url: url, openMs: Math.round(performance.now() - startedAt) });
    socket.send(JSON.stringify({ type: "subscribe", target: { kind: "system" } }));
    setTimeout(function () { socket.close(); }, 2000);
  };
  socket.onmessage = function (event) {
    post({ kind: "websocket", message: String(event.data).slice(0, 200) });
  };
  socket.onerror = function () {
    post({ kind: "websocket", ok: false, url: url, error: "error event" });
  };
  socket.onclose = function (event) {
    post({ kind: "websocket", closed: true, code: event.code, reason: event.reason });
  };
})();
true;
`;

export const TERMINAL_PROBE = String.raw`
(function () {
  var post = window.__bbSpike.post;
  var screens = document.querySelectorAll(".xterm-screen");
  var canvases = document.querySelectorAll(".xterm canvas");
  var rows = document.querySelectorAll(".xterm-rows > div");
  var kinds = [];
  for (var i = 0; i < canvases.length; i += 1) {
    kinds.push(canvases[i].className || "(unnamed)");
  }
  var viewport = document.querySelector(".xterm-viewport");
  post({
    kind: "terminal",
    xtermRoots: document.querySelectorAll(".xterm").length,
    screens: screens.length,
    canvases: canvases.length,
    canvasClasses: kinds,
    domRows: rows.length,
    // The WebGL addon paints into canvases and leaves .xterm-rows empty; the
    // DOM renderer fills .xterm-rows and creates no canvas.
    renderer: canvases.length > 0 ? "canvas/webgl" : rows.length > 0 ? "dom" : "none",
    viewportScrollHeight: viewport ? viewport.scrollHeight : null,
    viewportScrollTop: viewport ? Math.round(viewport.scrollTop) : null,
    viewportClientHeight: viewport ? viewport.clientHeight : null,
    hasTextarea: Boolean(document.querySelector(".xterm-helper-textarea")),
    focused: document.activeElement ? document.activeElement.className : null,
  });
})();
true;
`;

export const VIEWPORT_WATCH_PROBE = String.raw`
(function () {
  var post = window.__bbSpike.post;
  if (window.__bbViewportWatch) {
    window.__bbViewportWatch();
    delete window.__bbViewportWatch;
    post({ kind: "viewport", stopped: true });
    return;
  }
  var viewport = window.visualViewport;
  if (!viewport) {
    post({ kind: "viewport", error: "no visualViewport" });
    return;
  }
  var sample = function (reason) {
    var composer = document.querySelector("textarea, [contenteditable='true']");
    var composerRect = composer ? composer.getBoundingClientRect() : null;
    var shell = document.querySelector(".bb-app-shell > div, #root > div");
    post({
      kind: "viewport",
      reason: reason,
      atMs: Math.round(performance.now()),
      innerHeight: window.innerHeight,
      viewportHeight: Math.round(viewport.height),
      viewportOffsetTop: Math.round(viewport.offsetTop),
      scrollY: Math.round(window.scrollY),
      scale: viewport.scale,
      shellHeightStyle: shell ? shell.style.height || null : null,
      shellTopStyle: shell ? shell.style.top || null : null,
      composerBottom: composerRect ? Math.round(composerRect.bottom) : null,
      composerTop: composerRect ? Math.round(composerRect.top) : null,
      keyboardGapPx: composerRect ? Math.round(viewport.height - composerRect.bottom) : null,
      activeElement: document.activeElement ? document.activeElement.tagName : null,
    });
  };
  var onResize = function () { sample("resize"); };
  var onScroll = function () { sample("scroll"); };
  var onFocusIn = function () { sample("focusin"); };
  var onFocusOut = function () { sample("focusout"); };
  viewport.addEventListener("resize", onResize);
  viewport.addEventListener("scroll", onScroll);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  window.__bbViewportWatch = function () {
    viewport.removeEventListener("resize", onResize);
    viewport.removeEventListener("scroll", onScroll);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
  };
  sample("start");
  post({ kind: "viewport", started: true });
})();
true;
`;

export const FOCUS_COMPOSER_PROBE = String.raw`
(function () {
  var composer = document.querySelector("textarea, [contenteditable='true']");
  if (!composer) {
    window.__bbSpike.post({ kind: "focus", ok: false, error: "no composer" });
  } else {
    composer.focus();
    window.__bbSpike.post({ kind: "focus", ok: true, tag: composer.tagName });
  }
})();
true;
`;

export const FILE_INPUT_PROBE = String.raw`
(function () {
  var inputs = Array.prototype.slice.call(document.querySelectorAll("input[type='file']"));
  window.__bbSpike.post({
    kind: "file-input",
    count: inputs.length,
    inputs: inputs.map(function (input) {
      return {
        multiple: input.multiple,
        accept: input.accept,
        capture: input.getAttribute("capture"),
        hidden: input.offsetParent === null,
      };
    }),
  });
})();
true;
`;

export const OPEN_FILE_CHOOSER_PROBE = String.raw`
(function () {
  var input = document.querySelector("input[type='file']");
  if (!input) {
    window.__bbSpike.post({ kind: "file-chooser", ok: false, error: "no input" });
    return;
  }
  input.addEventListener("change", function () {
    window.__bbSpike.post({
      kind: "file-chooser",
      changed: true,
      files: Array.prototype.slice.call(input.files || []).map(function (file) {
        return { name: file.name, type: file.type, bytes: file.size };
      }),
    });
  });
  input.click();
  window.__bbSpike.post({ kind: "file-chooser", ok: true, clicked: true });
})();
true;
`;

export const BUTTONS_PROBE = String.raw`
(function () {
  var nodes = Array.prototype.slice.call(document.querySelectorAll("button, [role='button'], [role='tab'], a[href]"));
  var described = nodes.map(function (node) {
    var rect = node.getBoundingClientRect();
    return {
      label: (node.getAttribute("aria-label") || node.title || node.textContent || "").trim().slice(0, 40),
      testId: node.getAttribute("data-testid"),
      visible: rect.width > 0 && rect.height > 0,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  }).filter(function (entry) { return entry.visible; });
  window.__bbSpike.post({ kind: "buttons", count: described.length, buttons: described.slice(0, 60) });
})();
true;
`;

export const TERMINAL_OPEN_PROBE = String.raw`
(function () {
  var post = window.__bbSpike.post;
  var press = function (element) {
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (type) {
      element.dispatchEvent(new (type.indexOf("pointer") === 0 ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true }));
    });
  };
  var findByLabel = function (pattern) {
    var nodes = Array.prototype.slice.call(document.querySelectorAll("button, [role='button'], [role='tab']"));
    for (var i = 0; i < nodes.length; i += 1) {
      var label = (nodes[i].getAttribute("aria-label") || nodes[i].title || nodes[i].textContent || "").trim();
      var rect = nodes[i].getBoundingClientRect();
      if (pattern.test(label) && rect.width > 0) return nodes[i];
    }
    return null;
  };
  var steps = [
    { name: "panel", pattern: /show right panel|open panel|workspace panel/i },
    { name: "newTab", pattern: /new tab|add tab/i },
    { name: "terminal", pattern: /start terminal/i },
  ];
  var index = 0;
  var run = function () {
    if (index >= steps.length) {
      post({ kind: "terminal-open", step: "done" });
      return;
    }
    var step = steps[index];
    index += 1;
    var target = findByLabel(step.pattern);
    if (target === null) {
      post({ kind: "terminal-open", step: step.name, ok: false, error: "not found" });
    } else {
      press(target);
      post({ kind: "terminal-open", step: step.name, ok: true, label: (target.getAttribute("aria-label") || target.textContent || "").trim().slice(0, 40) });
    }
    setTimeout(run, 1500);
  };
  run();
})();
true;
`;

export const SPIKE_PROBES = [
  { id: "environment", label: "Env", script: ENVIRONMENT_PROBE },
  { id: "boot", label: "Boot timing", script: BOOT_TIMING_PROBE },
  { id: "voice", label: "Voice", script: VOICE_PROBE },
  { id: "voice-export", label: "Voice out", script: VOICE_EXPORT_PROBE },
  { id: "voice-app", label: "Voice app", script: VOICE_APP_PROBE },
  { id: "voice-ui", label: "Voice UI", script: VOICE_UI_PROBE },
  { id: "clipboard", label: "Clipboard", script: CLIPBOARD_PROBE },
  { id: "websocket", label: "WebSocket", script: WEBSOCKET_PROBE },
  { id: "buttons", label: "Buttons", script: BUTTONS_PROBE },
  { id: "terminal-open", label: "Term open", script: TERMINAL_OPEN_PROBE },
  { id: "terminal", label: "Terminal", script: TERMINAL_PROBE },
  { id: "viewport", label: "Viewport", script: VIEWPORT_WATCH_PROBE },
  { id: "focus", label: "Focus", script: FOCUS_COMPOSER_PROBE },
  { id: "file-input", label: "Files?", script: FILE_INPUT_PROBE },
  { id: "file-chooser", label: "Pick file", script: OPEN_FILE_CHOOSER_PROBE },
] as const;

export type SpikeProbeId = (typeof SPIKE_PROBES)[number]["id"];
