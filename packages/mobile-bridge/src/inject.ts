import type { NativeShellHandshake } from "./handshake.js";
import { NATIVE_BRIDGE_GLOBAL } from "./version.js";

export interface NativeShellApi extends NativeShellHandshake {
  post(message: unknown): void;
  request(kind: string, payload: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
}

function encodeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

export function buildBridgeInjectionScript(
  handshake: NativeShellHandshake,
): string {
  return `
(function () {
  try {
    var root = window.${NATIVE_BRIDGE_GLOBAL} = window.${NATIVE_BRIDGE_GLOBAL} || {};
    if (root.native && root.native.__installed) {
      root.native.__apply(${encodeForScript(handshake)});
      return;
    }
    var handshake = ${encodeForScript(handshake)};
    var listeners = [];
    var pending = {};
    var nextId = 0;

    var post = function (message) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      } catch (error) {
        // A navigation can tear the bridge down mid-call. Losing a haptic is
        // never worth an exception in the page.
      }
    };

    var native = {
      __installed: true,
      __apply: function (next) {
        for (var key in next) {
          if (Object.prototype.hasOwnProperty.call(next, key)) {
            native[key] = next[key];
          }
        }
      },
      __receive: function (event) {
        if (event && event.type === "response") {
          var entry = pending[event.id];
          if (entry) {
            delete pending[event.id];
            clearTimeout(entry.timer);
            if (event.response && event.response.ok) {
              entry.resolve(event.response.result);
            } else {
              entry.reject(new Error((event.response && event.response.error) || "native request failed"));
            }
          }
          return;
        }
        if (event && event.type === "safe-area" && event.safeArea) {
          native.safeArea = event.safeArea;
        }
        for (var i = 0; i < listeners.length; i += 1) {
          try {
            listeners[i](event);
          } catch (error) {
            // One bad listener must not stop the others.
          }
        }
      },
      post: post,
      request: function (kind, payload) {
        return new Promise(function (resolve, reject) {
          var id = "r" + String(nextId++) + "-" + String(Date.now());
          // A shell that never answers must not leak the promise. Ten seconds
          // is far longer than any share sheet takes to open.
          var timer = setTimeout(function () {
            delete pending[id];
            reject(new Error("native request timed out"));
          }, 10000);
          pending[id] = { resolve: resolve, reject: reject, timer: timer };
          post({ type: "request", id: id, request: { kind: kind, payload: payload } });
        });
      },
      subscribe: function (listener) {
        listeners.push(listener);
        return function () {
          var index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    };
    native.__apply(handshake);
    root.native = native;
  } catch (error) {
    // No bridge is a supported state. Leave the page alone.
  }
})();
true;
`;
}

export function buildBridgeEventScript(event: unknown): string {
  return `
(function () {
  try {
    var native = window.${NATIVE_BRIDGE_GLOBAL} && window.${NATIVE_BRIDGE_GLOBAL}.native;
    if (native && native.__receive) native.__receive(${encodeForScript(event)});
  } catch (error) {}
})();
true;
`;
}
