import { useCallback, useMemo, type ReactNode } from "react";
import type { ComposerView } from "@get-bb/plugin-sdk";
import {
  useAppCommandContext,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import {
  PluginComposerHostProvider,
  PluginComposerViewProvider,
  type PluginComposerHost,
} from "./plugin-composer-host";

interface ComposerExtensionController {
  host: PluginComposerHost | null;
  view: ComposerView;
  focus(): boolean;
}

interface UseComposerExtensionControllerOptions {
  host: PluginComposerHost | null;
  view: ComposerView;
  isFocused: boolean;
  isPrimary: boolean;
  collapseIfFocused?(): boolean;
  focusDefault(): boolean;
}

export function useComposerExtensionController({
  host,
  view,
  isFocused,
  isPrimary,
  collapseIfFocused,
  focusDefault,
}: UseComposerExtensionControllerOptions): ComposerExtensionController {
  const focus = useCallback(() => {
    if (!isFocused || !isPrimary) return false;
    if (collapseIfFocused?.()) return true;
    if (host !== null) {
      host.focus();
      return true;
    }
    return focusDefault();
  }, [collapseIfFocused, focusDefault, host, isFocused, isPrimary]);
  useAppCommandContext("promptAvailable", true);
  useAppCommandHandler("composer.focus", focus);

  return useMemo(() => ({ host, view, focus }), [focus, host, view]);
}

export function ComposerExtensionHost({
  controller,
  defaultRenderer,
}: {
  controller: ComposerExtensionController;
  defaultRenderer: ReactNode;
}) {
  return (
    <PluginComposerViewProvider value={controller.view}>
      <PluginComposerHostProvider value={controller.host}>
        {defaultRenderer}
      </PluginComposerHostProvider>
    </PluginComposerViewProvider>
  );
}
