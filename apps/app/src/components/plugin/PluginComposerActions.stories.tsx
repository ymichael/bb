import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComposerView } from "@get-bb/plugin-sdk";
import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  makeAttachmentsConfig,
  makeThreadListEntry,
  makeTypeaheadConfig,
} from "../../../.ladle/story-fixtures";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
import { PromptBoxInternal } from "@/components/promptbox/PromptBoxInternal";
import {
  PluginComposerHostProvider,
  useComposerHostDraftNotifier,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
  type PluginRegistrationSet,
} from "@/lib/plugin-slots";
import { setPluginThreadRowStatus } from "@/lib/plugin-thread-row-status";
import type { PromptDraftState } from "@bb/client-core";
import {
  ThreadRow,
  type ThreadRowOptions,
} from "@/components/sidebar/ThreadRow";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

export default {
  title: "plugins/Composer actions",
};

const THREAD_ID = "thr_plugin_composer_story";
const PROJECT_ID = "proj_plugin_composer_story";

const THREAD_SCOPES: ComposerView["scope"]["kind"][] = ["thread"];

function registrations(
  actions: NonNullable<
    NonNullable<
      PluginRegistrationSet["composerCustomizations"]
    >[number]["actions"]
  >,
  scopes: ComposerView["scope"]["kind"][] = ["new-thread", "thread"],
): PluginRegistrationSet {
  return makePluginRegistrationSet({
    composerCustomizations: [{ id: "story-actions", scopes, actions }],
  });
}

function StoryPluginRegistration({
  pluginId,
  actions,
  scopes,
}: {
  pluginId: string;
  actions: Parameters<typeof registrations>[0];
  scopes?: ComposerView["scope"]["kind"][];
}) {
  useEffect(() => {
    setPluginSlotRegistrations(pluginId, registrations(actions, scopes));
    return () => removePluginSlotRegistrations(pluginId);
  }, [actions, pluginId, scopes]);
  return null;
}

function compactAction(label: string, icon: IconName): ComponentType {
  return function StoryComposerAction() {
    return (
      <Button type="button" size="icon" variant="ghost" aria-label={label}>
        <Icon name={icon} className="size-4" aria-hidden />
      </Button>
    );
  };
}

const OVERFLOW_PLUGINS = [
  ["story-composer-alpha", "Improve", "Zap"],
  ["story-composer-beta", "Search", "Search"],
  ["story-composer-gamma", "Plan", "ListTodo"],
  ["story-composer-delta", "Attach", "FileAttachment"],
  ["story-composer-epsilon", "Review", "Check"],
] as const satisfies readonly (readonly [string, string, IconName])[];

const OVERFLOW_REGISTRATIONS = OVERFLOW_PLUGINS.map(
  ([pluginId, label, icon]) => ({
    actions: [{ id: "primary", component: compactAction(label, icon) }],
    pluginId,
  }),
);

function OverflowFixture() {
  const [value, setValue] = useState("");
  return (
    <>
      {OVERFLOW_REGISTRATIONS.map(({ pluginId, actions }) => (
        <StoryPluginRegistration
          key={pluginId}
          pluginId={pluginId}
          actions={actions}
        />
      ))}
      <div className="w-full max-w-xl">
        <PromptBoxInternal
          value={value}
          mentionRanges={[]}
          onChange={(nextValue) => setValue(nextValue)}
          onSubmit={() => {}}
          placeholder="Ask a follow-up"
          typeahead={makeTypeaheadConfig()}
          mentionMenuPlacement="top"
          attachments={makeAttachmentsConfig()}
          submission={{
            isSubmitting: false,
            disabled: false,
            title: "Submit (Enter)",
          }}
        />
      </div>
    </>
  );
}

function ThreadRowStatusAction() {
  const statusOwner = useMemo(() => Symbol("thread-row-status-story"), []);
  const [status, setStatus] = useState<
    "running" | "success" | "error" | "clear"
  >("running");
  useEffect(() => {
    const setStatusForThread = (
      nextStatus: Parameters<typeof setPluginThreadRowStatus>[2],
    ) =>
      setPluginThreadRowStatus(
        THREAD_ID,
        "story-thread-row-status",
        nextStatus,
        statusOwner,
      );
    if (status === "running") {
      setStatusForThread({
        icon: "Zap",
        label: "Plugin running",
        tone: "running",
      });
    } else if (status === "success") {
      setStatusForThread({
        icon: "Check",
        label: "Plugin completed",
        tone: "success",
      });
    } else if (status === "error") {
      setStatusForThread({
        icon: "AlertCircle",
        label: "Plugin failed",
        tone: "error",
      });
    } else {
      setStatusForThread(null);
    }
    return () => setStatusForThread(null);
  }, [status, statusOwner]);

  return (
    <div className="flex items-center gap-0.5">
      <Button
        type="button"
        size="icon"
        variant={status === "running" ? "secondary" : "ghost"}
        aria-label="Show running plugin run"
        onClick={() => setStatus("running")}
      >
        <Icon name="Zap" className="size-4" aria-hidden />
      </Button>
      <Button
        type="button"
        size="icon"
        variant={status === "success" ? "secondary" : "ghost"}
        aria-label="Show successful plugin run"
        onClick={() => setStatus("success")}
      >
        <Icon name="Check" className="size-4" aria-hidden />
      </Button>
      <Button
        type="button"
        size="icon"
        variant={status === "error" ? "secondary" : "ghost"}
        aria-label="Show failed plugin run"
        onClick={() => setStatus("error")}
      >
        <Icon name="AlertCircle" className="size-4" aria-hidden />
      </Button>
      <Button
        type="button"
        size="icon"
        variant={status === "clear" ? "secondary" : "ghost"}
        aria-label="Clear plugin run status"
        onClick={() => setStatus("clear")}
      >
        <Icon name="X" className="size-4" aria-hidden />
      </Button>
    </div>
  );
}

const STATUS_ACTIONS = [
  { id: "thread-row-status", component: ThreadRowStatusAction },
] as const;

const THREAD_ROW_OPTIONS: ThreadRowOptions = {
  kind: "default",
  depth: 1,
  isCompact: false,
};

function ThreadRowStatusFixture() {
  const [draft, setDraft] = useState<PromptDraftState>({
    text: "Make the release note shorter and easier to scan.",
    mentions: [],
    attachments: [],
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const subscribeDraft = useComposerHostDraftNotifier(draft);
  const composerHost = useMemo<PluginComposerHost>(
    () => ({
      scope: { kind: "thread", threadId: THREAD_ID },
      textEffectKey: `story:${THREAD_ID}`,
      getCurrent: () => draftRef.current,
      subscribeDraft,
      setDraft,
      focus: () => {},
    }),
    [subscribeDraft],
  );
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <StoryPluginRegistration
        pluginId="story-composer-status"
        actions={STATUS_ACTIONS}
        scopes={THREAD_SCOPES}
      />
      <PluginComposerHostProvider value={composerHost}>
        <div className="grid w-full max-w-4xl gap-4 md:grid-cols-[20rem_minmax(0,1fr)]">
          <ThreadActionsProvider>
            <div className="rounded-md bg-sidebar p-2 text-sidebar-foreground">
              <SidebarMenu>
                <SidebarMenuItem>
                  <ThreadRow
                    projectId={PROJECT_ID}
                    crossProjectId={null}
                    thread={makeThreadListEntry({
                      id: THREAD_ID,
                      projectId: PROJECT_ID,
                      title: "Improve release notes",
                      titleFallback: "Improve release notes",
                    })}
                    isActive={false}
                    hasComposerDraft={false}
                    options={THREAD_ROW_OPTIONS}
                  />
                </SidebarMenuItem>
              </SidebarMenu>
            </div>
          </ThreadActionsProvider>
          <PromptBoxInternal
            value={draft.text}
            mentionRanges={draft.mentions}
            onChange={(text, mentions) =>
              setDraft((current) => ({
                ...current,
                text,
                mentions: [...mentions],
              }))
            }
            onSubmit={() => {}}
            placeholder="Ask a follow-up"
            typeahead={makeTypeaheadConfig()}
            mentionMenuPlacement="top"
            attachments={makeAttachmentsConfig()}
            submission={{
              isSubmitting: false,
              disabled: false,
              title: "Submit (Enter)",
            }}
          />
        </div>
      </PluginComposerHostProvider>
    </QueryClientProvider>
  );
}

export function Overflow() {
  return (
    <StoryCard>
      <StoryRow
        label="five plugins"
        hint="three plugin groups inline; use an overflow action, close the menu, and it is promoted by usage"
      >
        <OverflowFixture />
      </StoryRow>
    </StoryCard>
  );
}

export function ThreadRowStatus() {
  return (
    <StoryCard>
      <StoryRow
        label="plugin-provided thread status"
        hint="use the composer actions to show a shimmering running icon, static success or failure, and cleanup in the real thread row"
      >
        <ThreadRowStatusFixture />
      </StoryRow>
    </StoryCard>
  );
}
