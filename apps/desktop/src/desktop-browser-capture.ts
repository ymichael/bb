import { nativeImage, type NativeImage, type WebContents } from "electron";
import { z } from "zod";
import type { DesktopBrowserCdpPage } from "./desktop-browser-cdp.js";

const screenshotSchema = z.object({
  data: z
    .string()
    .min(1)
    .max(16 * 1024 * 1024),
});

export async function captureDesktopBrowserCdpScreenshot(
  contents: WebContents,
  params: Parameters<DesktopBrowserCdpPage["send"]>[1],
  sessionId?: string,
) {
  let finished = false;
  let finish: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  const command = contents.debugger
    .sendCommand("Page.captureScreenshot", params, sessionId)
    .then((result) => z.record(z.string(), z.json()).parse(result))
    .finally(() => {
      finished = true;
      finish();
    });
  const frames = async () => {
    while (!finished) {
      await Promise.race([
        stopped,
        contents
          .capturePage(undefined, { stayHidden: true, stayAwake: true })
          .catch((error) => {
            if (contents.isDestroyed()) throw error;
          }),
      ]);
      if (finished) break;
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => {
          frameTimer = setTimeout(resolve, 16);
        }),
      ]);
      if (frameTimer !== undefined) clearTimeout(frameTimer);
    }
    return command;
  };
  try {
    return await Promise.race([
      command,
      frames(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Native browser screenshot timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    finished = true;
    finish();
    if (timeout !== undefined) clearTimeout(timeout);
    if (frameTimer !== undefined) clearTimeout(frameTimer);
  }
}

export async function captureDesktopBrowserPage(
  contents: WebContents,
): Promise<NativeImage> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let ownsAttachment = false;
  let active = true;
  let previousBackgroundThrottling: boolean | null = null;
  const debuggerApi = contents.debugger;
  const restoreBackgroundThrottling = () => {
    if (previousBackgroundThrottling !== null && !contents.isDestroyed())
      contents.setBackgroundThrottling(previousBackgroundThrottling);
    previousBackgroundThrottling = null;
  };
  const detached = () => {
    ownsAttachment = false;
    restoreBackgroundThrottling();
  };
  try {
    return await Promise.race([
      (async () => {
        try {
          const image = await contents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          });
          if (image.isEmpty())
            throw new Error("Native browser capture is empty");
          return image;
        } catch {
          if (!active) throw new Error("Native browser capture timed out");
          if (contents.isDestroyed())
            throw new Error("Native browser tab is unavailable");
          if (!debuggerApi.isAttached()) {
            debuggerApi.attach("1.3");
            ownsAttachment = true;
            previousBackgroundThrottling = contents.getBackgroundThrottling();
            contents.setBackgroundThrottling(false);
            debuggerApi.on("detach", detached);
            z.record(z.string(), z.json()).parse(
              await debuggerApi.sendCommand(
                "Emulation.setFocusEmulationEnabled",
                { enabled: true },
              ),
            );
            if (!active || !ownsAttachment || contents.isDestroyed())
              throw new Error("Native browser capture was interrupted");
          }
          const result = screenshotSchema.parse(
            await captureDesktopBrowserCdpScreenshot(contents, {
              format: "jpeg",
              quality: 80,
              captureBeyondViewport: false,
            }),
          );
          return nativeImage.createFromBuffer(
            Buffer.from(result.data, "base64"),
          );
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Native browser capture timed out")),
          15_000,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    active = false;
    if (timeout !== undefined) clearTimeout(timeout);
    debuggerApi.off("detach", detached);
    restoreBackgroundThrottling();
    if (ownsAttachment && !contents.isDestroyed() && debuggerApi.isAttached())
      debuggerApi.detach();
  }
}
