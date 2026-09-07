import { useEffect, type RefObject } from "react";

type AppShellElement = HTMLDivElement;
type BrowserPlatform = Pick<
  Navigator,
  "maxTouchPoints" | "platform" | "userAgent"
>;

export function shouldRestoreIOSViewportOnKeyboardDismissal({
  maxTouchPoints,
  platform,
  userAgent,
}: BrowserPlatform): boolean {
  const isAppleWebKit = /\bAppleWebKit\//u.test(userAgent);
  const isIOSDevice =
    /\b(?:iPad|iPhone|iPod)\b/u.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1);
  return isAppleWebKit && isIOSDevice;
}

export const SHELL_SAFE_AREA_BOTTOM_PROPERTY = "--bb-safe-area-bottom";

export const KEYBOARD_OPEN_MIN_SHRINK_PX = 80;

function getVisualViewportPageTop(visualViewport: VisualViewport) {
  return Math.round(window.scrollY + visualViewport.offsetTop);
}

export function isKeyboardFocusTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}

export function useMobileVisualViewportHeight(
  shellRef: RefObject<AppShellElement | null>,
  enabled: boolean,
  restoreImmediatelyOnKeyboardDismissal: boolean,
) {
  useEffect(() => {
    const shell = shellRef.current;
    const visualViewport = window.visualViewport;
    if (!shell || !enabled || !visualViewport) return;
    const viewportStyleRoot = shell.ownerDocument.body;

    let animationFrame: number | null = null;
    let appliedOverride: { top: number; height: number } | null = null;
    let shellContainingBlockHeight = 0;
    let shellContainingBlockHeightStale = true;
    let viewportHeightBeforeKeyboard: number | null = null;
    let appliedKeyboardInset = false;
    const setKeyboardInset = (open: boolean) => {
      if (open === appliedKeyboardInset) return;
      appliedKeyboardInset = open;
      if (open) {
        viewportStyleRoot.style.setProperty(
          SHELL_SAFE_AREA_BOTTOM_PROPERTY,
          "0px",
        );
      } else {
        viewportStyleRoot.style.removeProperty(SHELL_SAFE_AREA_BOTTOM_PROPERTY);
      }
    };
    const updateKeyboardInset = () => {
      if (
        viewportHeightBeforeKeyboard === null ||
        !isKeyboardFocusTarget(document.activeElement)
      ) {
        setKeyboardInset(false);
        return;
      }
      setKeyboardInset(
        viewportHeightBeforeKeyboard - visualViewport.height >=
          KEYBOARD_OPEN_MIN_SHRINK_PX,
      );
    };
    const clearViewportOverride = () => {
      if (appliedOverride === null) return;
      appliedOverride = null;
      shell.style.removeProperty("top");
      shell.style.removeProperty("height");
      viewportStyleRoot.style.removeProperty("--bb-shell-height");
    };
    const updateHeight = () => {
      animationFrame = null;
      updateKeyboardInset();
      if (visualViewport.scale !== 1) {
        clearViewportOverride();
        return;
      }

      const visualViewportHeight = Math.round(visualViewport.height);
      if (shellContainingBlockHeightStale) {
        shellContainingBlockHeight = document.body.clientHeight;
        shellContainingBlockHeightStale = false;
      }
      const hasVisualViewportPan =
        visualViewport.offsetTop > 1 || window.scrollY > 0;
      if (
        Math.abs(shellContainingBlockHeight - visualViewportHeight) <= 1 &&
        !hasVisualViewportPan
      ) {
        clearViewportOverride();
        return;
      }

      if (hasVisualViewportPan) {
        window.scrollTo(0, 0);
      }
      const shellTop = getVisualViewportPageTop(visualViewport);
      if (
        appliedOverride !== null &&
        appliedOverride.top === shellTop &&
        appliedOverride.height === visualViewportHeight
      ) {
        return;
      }
      appliedOverride = { top: shellTop, height: visualViewportHeight };
      shell.style.top = `${shellTop}px`;
      shell.style.height = `${visualViewportHeight}px`;
      viewportStyleRoot.style.setProperty(
        "--bb-shell-height",
        `${visualViewportHeight}px`,
      );
    };
    const scheduleUpdate = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      animationFrame = window.requestAnimationFrame(updateHeight);
    };
    const scheduleContainingBlockUpdate = () => {
      shellContainingBlockHeightStale = true;
      scheduleUpdate();
    };
    const handleVisualViewportScroll = () => {
      if (
        appliedOverride === null &&
        !isKeyboardFocusTarget(document.activeElement)
      ) {
        return;
      }
      scheduleUpdate();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (!isKeyboardFocusTarget(event.target)) return;
      if (isKeyboardFocusTarget(event.relatedTarget)) return;
      viewportHeightBeforeKeyboard = null;
      setKeyboardInset(false);
      if (!restoreImmediatelyOnKeyboardDismissal) return;
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      clearViewportOverride();
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!isKeyboardFocusTarget(event.target)) return;
      viewportHeightBeforeKeyboard ??= visualViewport.height;
      scheduleContainingBlockUpdate();
    };

    updateHeight();
    visualViewport.addEventListener("resize", scheduleUpdate);
    visualViewport.addEventListener("scroll", handleVisualViewportScroll);
    window.addEventListener("resize", scheduleContainingBlockUpdate);
    window.addEventListener("orientationchange", scheduleContainingBlockUpdate);
    document.addEventListener("focusout", handleFocusOut);
    document.addEventListener("focusin", handleFocusIn);

    return () => {
      visualViewport.removeEventListener("resize", scheduleUpdate);
      visualViewport.removeEventListener("scroll", handleVisualViewportScroll);
      window.removeEventListener("resize", scheduleContainingBlockUpdate);
      window.removeEventListener(
        "orientationchange",
        scheduleContainingBlockUpdate,
      );
      document.removeEventListener("focusout", handleFocusOut);
      document.removeEventListener("focusin", handleFocusIn);
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      setKeyboardInset(false);
      clearViewportOverride();
    };
  }, [enabled, restoreImmediatelyOnKeyboardDismissal, shellRef]);
}
