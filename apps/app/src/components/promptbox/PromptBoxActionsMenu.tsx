import { useCallback, useRef } from "react";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import {
  PluginComposerPlusMenuEntry,
  type PluginComposerPlusMenuContribution,
  type PluginComposerPlusMenuSelection,
} from "@/components/plugin/PluginComposerActions";
import { useResolvedComposerPlusMenuItems } from "@/components/plugin/composer-slot-hooks";
import { useOptionalPluginComposerView } from "@/components/plugin/plugin-composer-host";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { CREATE_PLUGIN_PROMPT } from "@bb/client-core";
import type { ProviderPromptActionCommand } from "@bb/client-core";

type PromptBoxActionKind = "skills" | "plan" | "goal" | "automation" | "plugin";

export interface PromptBoxAction {
  kind: PromptBoxActionKind;
  text: string;
  command?: ProviderPromptActionCommand;
  label?: string;
  disabled?: boolean;
}

interface PromptBoxActionsMenuProps {
  actions?: readonly PromptBoxAction[];
  isAttaching?: boolean;
  onAttach?: () => void;
  onAction: (action: PromptBoxAction) => void;
  pluginItems?: readonly PluginComposerPlusMenuContribution[];
}

export function ComposerPlusMenuSlot({
  includePluginContributions = true,
  ...props
}: Omit<PromptBoxActionsMenuProps, "pluginItems"> & {
  includePluginContributions?: boolean;
}) {
  const view = useOptionalPluginComposerView();
  const pluginItems = useResolvedComposerPlusMenuItems(
    includePluginContributions ? (view?.scope.kind ?? null) : null,
  );
  return <PromptBoxActionsMenu {...props} pluginItems={pluginItems} />;
}

export const AUTOMATION_PROMPT_ACTION: PromptBoxAction = {
  kind: "automation",
  command: { trigger: "/", name: "automation", trailingText: " " },
  text: "/automation ",
};

export const CREATE_PLUGIN_PROMPT_ACTION: PromptBoxAction = {
  kind: "plugin",
  text: CREATE_PLUGIN_PROMPT,
};

const PROMPT_ACTION_ORDER: readonly PromptBoxActionKind[] = [
  "skills",
  "plan",
  "goal",
  "automation",
  "plugin",
];

const PROMPT_ACTION_PRESENTATION = {
  skills: {
    label: "Skills",
    icon: "Zap",
  },
  plan: {
    label: "Plan",
    icon: "ListTodo",
  },
  goal: {
    label: "Goal",
    icon: "Target",
  },
  automation: {
    label: "Automation",
    icon: "Repeat",
  },
  plugin: {
    label: "Plugin",
    icon: "ElectricPlugs",
  },
} as const satisfies Record<
  PromptBoxActionKind,
  { label: string; icon: IconName }
>;

export function withAppPromptActions(
  actions: readonly PromptBoxAction[],
): PromptBoxAction[] {
  const appActions = [AUTOMATION_PROMPT_ACTION, CREATE_PLUGIN_PROMPT_ACTION];
  return [
    ...actions,
    ...appActions.filter(
      (appAction) => !actions.some((action) => action.kind === appAction.kind),
    ),
  ];
}

function orderedPromptActions(
  actions: readonly PromptBoxAction[],
): PromptBoxAction[] {
  return PROMPT_ACTION_ORDER.flatMap((kind) => {
    const action = actions.find((candidate) => candidate.kind === kind);
    return action ? [action] : [];
  });
}

export function PromptBoxActionsMenu({
  actions = [],
  isAttaching = false,
  onAttach,
  onAction,
  pluginItems = [],
}: PromptBoxActionsMenuProps) {
  const selectedItemRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pluginSelectionRef = useRef<PluginComposerPlusMenuSelection | null>(
    null,
  );
  const visibleActions = orderedPromptActions(actions).filter(
    (action) => action.text.length > 0,
  );
  const clearSelectedActionAfterClose = useCallback(() => {
    const clear = () => {
      selectedItemRef.current = false;
      pluginSelectionRef.current = null;
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(clear);
      return;
    }
    setTimeout(clear, 0);
  }, []);
  const restorePluginComposerFocus = useCallback(
    (selection: PluginComposerPlusMenuSelection) => {
      const activeElement = document.activeElement;
      const pluginMovedFocus =
        activeElement !== null &&
        activeElement !== document.body &&
        activeElement !== triggerRef.current &&
        activeElement !== selection.selectedElement &&
        activeElement.isConnected;
      if (!pluginMovedFocus) {
        selection.restoreComposerFocus();
      }
    },
    [],
  );

  if (visibleActions.length === 0 && !onAttach && pluginItems.length === 0) {
    return null;
  }

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          clearSelectedActionAfterClose();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Prompt actions"
          className={cn(
            COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
            CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
            "-ml-1.5",
          )}
        >
          <Icon name="Plus" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label="Prompt actions"
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-36"
        mobileTitle="Prompt actions"
        onCloseAutoFocus={(event) => {
          if (selectedItemRef.current) {
            event.preventDefault();
            const pluginSelection = pluginSelectionRef.current;
            if (pluginSelection) {
              restorePluginComposerFocus(pluginSelection);
            }
          }
        }}
      >
        {onAttach ? (
          <>
            <DropdownMenuItem
              disabled={isAttaching}
              onSelect={() => {
                selectedItemRef.current = true;
                onAttach();
              }}
            >
              <Icon
                name={isAttaching ? "Spinner" : "Paperclip"}
                className={cn(
                  "size-4 text-muted-foreground",
                  isAttaching && "animate-spin",
                )}
                aria-hidden
              />
              Attach files
            </DropdownMenuItem>
            {visibleActions.length > 0 ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        {visibleActions.map((action) => {
          const presentation = PROMPT_ACTION_PRESENTATION[action.kind];
          return (
            <DropdownMenuItem
              key={action.kind}
              disabled={action.disabled}
              onSelect={() => {
                selectedItemRef.current = true;
                onAction(action);
              }}
            >
              <Icon
                name={presentation.icon}
                className="size-4 text-muted-foreground"
                aria-hidden
              />
              {action.label ?? presentation.label}
            </DropdownMenuItem>
          );
        })}
        {pluginItems.length > 0 ? <DropdownMenuSeparator /> : null}
        {pluginItems.map((contribution, index) => {
          const contributingPluginCount = new Set(
            pluginItems.map((candidate) => candidate.pluginId),
          ).size;
          const previous = pluginItems[index - 1];
          const startsPluginGroup =
            contributingPluginCount >= 2 &&
            previous?.pluginId !== contribution.pluginId;
          return (
            <PluginComposerPlusMenuEntry
              key={contribution.key}
              contribution={contribution}
              showPluginLabel={startsPluginGroup}
              onSelected={(selection) => {
                selectedItemRef.current = true;
                pluginSelectionRef.current = selection;
                queueMicrotask(() => restorePluginComposerFocus(selection));
              }}
            />
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
