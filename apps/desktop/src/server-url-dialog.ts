import { BrowserWindow, ipcMain } from "electron";
import { escapeHtmlText } from "@bb/domain";
import {
  BB_DESKTOP_SERVER_URL_DIALOG_CANCEL_CHANNEL,
  BB_DESKTOP_SERVER_URL_DIALOG_SUBMIT_CHANNEL,
  serverUrlDialogSubmitRequestSchema,
  type ServerUrlDialogSubmitResponse,
} from "./server-url-dialog-ipc.js";
import { normalizeCustomServerUrl } from "./server-target.js";

type ServerUrlDialogResult =
  | { kind: "cancelled" }
  | { kind: "clear" }
  | { kind: "set"; url: string };

interface OpenServerUrlDialogArgs {
  initialUrl: string | null;
  parentWindow: BrowserWindow | null;
  preloadPath: string;
}

function renderServerUrlDialogHtml(initialUrl: string | null): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>Set Server URL</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body {
      background: Canvas;
      color: CanvasText;
      margin: 0;
      padding: 20px;
    }

    h1 {
      font-size: 14px;
      font-weight: 600;
      margin: 0 0 4px;
    }

    p {
      color: color-mix(in srgb, CanvasText 70%, transparent);
      font-size: 12px;
      line-height: 1.45;
      margin: 0 0 12px;
    }

    input {
      background: Field;
      border: 1px solid color-mix(in srgb, CanvasText 24%, transparent);
      border-radius: 6px;
      box-sizing: border-box;
      color: FieldText;
      font-size: 13px;
      padding: 6px 8px;
      width: 100%;
    }

    [data-error] {
      color: #c0392b;
      font-size: 12px;
      line-height: 1.4;
      margin: 8px 0 0;
      min-height: 16px;
    }

    .actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 12px;
    }

    button {
      background: color-mix(in srgb, CanvasText 8%, Canvas);
      border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
      border-radius: 6px;
      color: CanvasText;
      font-size: 13px;
      padding: 5px 14px;
    }

    button[type="submit"] {
      background: AccentColor;
      border-color: AccentColor;
      color: AccentColorText;
    }
  </style>
</head>
<body>
  <h1>Set Server URL</h1>
  <p>Point this app at a bb server. Leave empty to use only This Mac.</p>
  <form>
    <input name="url" type="text" placeholder="https://example.com:38886" value="${escapeHtmlText(initialUrl ?? "")}" autocomplete="off" spellcheck="false">
    <div data-error></div>
    <div class="actions">
      <button type="button" data-cancel>Cancel</button>
      <button type="submit">Save</button>
    </div>
  </form>
</body>
</html>`;
}

let openDialog: {
  result: Promise<ServerUrlDialogResult>;
  window: BrowserWindow;
} | null = null;

export function openServerUrlDialog(
  args: OpenServerUrlDialogArgs,
): Promise<ServerUrlDialogResult> {
  if (openDialog !== null && !openDialog.window.isDestroyed()) {
    openDialog.window.focus();
    return openDialog.result;
  }

  const dialogWindow = new BrowserWindow({
    fullscreenable: false,
    height: 208,
    maximizable: false,
    minimizable: false,
    modal: args.parentWindow !== null,
    parent: args.parentWindow ?? undefined,
    resizable: false,
    show: false,
    title: "Set Server URL",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: args.preloadPath,
      sandbox: true,
    },
    width: 440,
  });

  const result = new Promise<ServerUrlDialogResult>((resolvePromise) => {
    let settled = false;

    function finish(dialogResult: ServerUrlDialogResult): void {
      if (settled) {
        return;
      }
      settled = true;
      ipcMain.removeHandler(BB_DESKTOP_SERVER_URL_DIALOG_SUBMIT_CHANNEL);
      ipcMain.removeListener(
        BB_DESKTOP_SERVER_URL_DIALOG_CANCEL_CHANNEL,
        handleCancel,
      );
      openDialog = null;
      if (!dialogWindow.isDestroyed()) {
        dialogWindow.close();
      }
      resolvePromise(dialogResult);
    }

    function handleCancel(event: { sender: { id: number } }): void {
      if (event.sender.id === dialogWindow.webContents.id) {
        finish({ kind: "cancelled" });
      }
    }

    ipcMain.handle(
      BB_DESKTOP_SERVER_URL_DIALOG_SUBMIT_CHANNEL,
      (event, payload): ServerUrlDialogSubmitResponse => {
        if (event.sender.id !== dialogWindow.webContents.id) {
          return { ok: false, message: "Unexpected sender." };
        }
        const parsed = serverUrlDialogSubmitRequestSchema.safeParse(payload);
        if (!parsed.success) {
          return { ok: false, message: "Enter a valid http(s) URL." };
        }
        if (parsed.data.url.trim().length === 0) {
          finish({ kind: "clear" });
          return { ok: true };
        }
        const normalized = normalizeCustomServerUrl(parsed.data.url);
        if (normalized === null) {
          return { ok: false, message: "Enter a valid http(s) URL." };
        }
        finish({ kind: "set", url: normalized });
        return { ok: true };
      },
    );
    ipcMain.on(BB_DESKTOP_SERVER_URL_DIALOG_CANCEL_CHANNEL, handleCancel);
    dialogWindow.on("closed", () => {
      finish({ kind: "cancelled" });
    });
  });

  openDialog = { result, window: dialogWindow };

  dialogWindow.once("ready-to-show", () => {
    dialogWindow.show();
  });
  void dialogWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      renderServerUrlDialogHtml(args.initialUrl),
    )}`,
  );

  return result;
}
