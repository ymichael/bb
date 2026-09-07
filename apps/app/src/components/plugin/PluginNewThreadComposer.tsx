import { useContext, useState } from "react";
import type {
  NewThreadComposerProps as PluginComposerProps,
  NewThreadRequest,
} from "@get-bb/plugin-sdk";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  NewThreadComposer,
  type NewThreadComposerSeed,
} from "@/components/promptbox/NewThreadComposer";
import { PluginContext } from "@/components/plugin/plugin-context";

export function PluginNewThreadComposer({
  defaultProjectId,
  defaultProviderId,
  defaultModel,
  defaultReasoningLevel,
  defaultServiceTier,
  defaultPermissionMode,
  defaultEnvironment,
  initialPrompt,
  placeholder,
  layout = "contained",
  focusRequest,
  className,
  draftKey,
  onSubmit,
}: PluginComposerProps) {
  const pluginId = useContext(PluginContext);
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(
    defaultProjectId ?? null,
  );
  const [seededDefaultProjectId, setSeededDefaultProjectId] =
    useState(defaultProjectId);
  if (seededDefaultProjectId !== defaultProjectId) {
    setSeededDefaultProjectId(defaultProjectId);
    setPickedProjectId(defaultProjectId ?? null);
  }

  const seed: NewThreadComposerSeed = {
    providerId: defaultProviderId,
    model: defaultModel,
    reasoningLevel: defaultReasoningLevel,
    serviceTier: defaultServiceTier,
    permissionMode: defaultPermissionMode,
    environment: defaultEnvironment,
    initialPrompt,
  };
  const composerKey = draftKey ?? pluginId ?? "default";
  const handleSubmit = async (request: NewThreadRequest) => {
    await onSubmit({
      ...request,
      executionInputSources: {
        ...request.executionInputSources,
        providerId: "explicit",
      },
    });
  };

  return (
    <NewThreadComposer
      projectId={pickedProjectId}
      onProjectChange={setPickedProjectId}
      draftStorage={{ kind: "plugin-new-thread", key: composerKey }}
      selectionScope="component-local"
      seed={seed}
      resetKey={defaultProjectId ?? null}
      focusRequest={focusRequest}
      onSubmit={handleSubmit}
    >
      {({ renderPromptBox }) => (
        <div
          className={cn(
            layout === "contained"
              ? "flex h-full min-h-0 flex-col justify-end"
              : "flex flex-col",
            className,
          )}
        >
          {renderPromptBox({
            placeholder,
            allowNoProject: true,
          })}
        </div>
      )}
    </NewThreadComposer>
  );
}
