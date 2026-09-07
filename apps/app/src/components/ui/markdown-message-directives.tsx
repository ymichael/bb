import {
  createContext,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";
import type { Nodes, Parent, RootContent } from "mdast";
import type {} from "mdast-util-to-hast";
import type {
  BbNavigate,
  PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk";
import { visit } from "unist-util-visit";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount.js";
import { PluginThreadPanelNavigationProvider } from "@/components/plugin/plugin-thread-panel-navigation.js";
import {
  resolveMessageDirectiveRegistry,
  type ResolvedMessageDirective,
} from "@/lib/plugin-slot-resolvers.js";
import type { PluginMessageDirectiveSlot } from "@/lib/plugin-slots.js";

export const MESSAGE_DIRECTIVE_MOUNT_LIMIT = 32;

const MESSAGE_DIRECTIVE_HAST_NAME = "bb-message-directive";
const MESSAGE_DIRECTIVE_INDEX_PROPERTY = "dataDirectiveIndex";

type MessageDirectiveRegistryEntry = ResolvedMessageDirective;

export type MessageDirectiveRegistry = ReadonlyMap<
  string,
  MessageDirectiveRegistryEntry
>;

export interface MountedMessageDirective {
  attributes: Readonly<Record<string, string>>;
  index: number;
  slot: PluginMessageDirectiveSlot;
  source: string;
}

export interface MarkdownMessageDirectives {
  registry: MessageDirectiveRegistry;
  message: PluginMessageDirectiveProps["message"];
  openWorkspaceFile: PluginMessageDirectiveProps["openWorkspaceFile"];
  openThreadPanel: MarkdownMessageDirectiveOpenThreadPanel | null;
}

export type MarkdownMessageDirectiveOpenThreadPanel = (
  options: Parameters<BbNavigate["openThreadPanel"]>[0] & {
    pluginId: string;
  },
) => boolean;

type DirectiveNodeType = "textDirective" | "leafDirective";

interface DirectiveNode {
  type: DirectiveNodeType;
  name?: string;
  attributes?: Record<string, string | null | undefined> | null;
  children?: unknown[];
  position?: {
    start?: { offset?: number | undefined };
    end?: { offset?: number | undefined };
  };
}

const DIRECTIVE_MARKERS: Record<DirectiveNodeType, string> = {
  textDirective: ":",
  leafDirective: "::",
};

interface RemarkMessageDirectiveFile {
  value: unknown;
}

interface MessageDirectiveElementProps {
  "data-directive-index"?: string;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "bb-message-directive": MessageDirectiveElementProps;
    }
  }
}

export function buildMessageDirectiveRegistry(
  slots: readonly PluginMessageDirectiveSlot[],
  options?: { warn?: (message: string) => void },
): MessageDirectiveRegistry {
  const warn = options?.warn ?? defaultCollisionWarn;
  const registry = resolveMessageDirectiveRegistry(slots);
  for (const [id, directive] of registry) {
    if (directive.status === "collision") {
      warn(
        `[plugin] message directive "${id}" claimed by multiple plugins (${directive.pluginIds.join(", ")}); rendering as literal text`,
      );
    }
  }
  return registry;
}

function defaultCollisionWarn(message: string): void {
  console.warn(message);
}

export function normalizeDirectiveAttributes(
  attributes: Record<string, string | null | undefined> | null | undefined,
): Record<string, string> {
  if (attributes === null || attributes === undefined) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function reconstructDirectiveSource(
  name: string,
  attributes: Readonly<Record<string, string>>,
  marker = "::",
): string {
  const keys = Object.keys(attributes);
  if (keys.length === 0) {
    return `${marker}${name}`;
  }
  const body = keys
    .map((key) => `${key}=${JSON.stringify(attributes[key] ?? "")}`)
    .join(" ");
  return `${marker}${name}{${body}}`;
}

function directiveSourceFromNode(
  node: DirectiveNode,
  markdownSource: string,
  name: string,
  attributes: Readonly<Record<string, string>>,
  marker: string,
): string {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (
    typeof start === "number" &&
    typeof end === "number" &&
    start >= 0 &&
    end >= start &&
    end <= markdownSource.length
  ) {
    return markdownSource.slice(start, end);
  }
  return reconstructDirectiveSource(name, attributes, marker);
}

function messageDirectiveMountNode(index: number): RootContent {
  return {
    type: "paragraph",
    children: [],
    data: {
      hName: MESSAGE_DIRECTIVE_HAST_NAME,
      hProperties: { [MESSAGE_DIRECTIVE_INDEX_PROPERTY]: index },
    },
  };
}

function spliceLiteralDirective(
  parent: Parent,
  index: number,
  type: DirectiveNodeType,
  source: string,
): number {
  if (type !== "textDirective") {
    parent.children.splice(index, 1, {
      type: "paragraph",
      children: [{ type: "text", value: source }],
    });
    return index;
  }

  const previous = parent.children[index - 1];
  const next = parent.children[index + 1];
  if (previous?.type === "text") {
    previous.value += source;
    previous.position = undefined;
    if (next?.type === "text") {
      previous.value += next.value;
      parent.children.splice(index, 2);
    } else {
      parent.children.splice(index, 1);
    }
    return index;
  }
  if (next?.type === "text") {
    next.value = `${source}${next.value}`;
    next.position = undefined;
    parent.children.splice(index, 1);
    return index;
  }
  parent.children.splice(index, 1, { type: "text", value: source });
  return index;
}

function asDirectiveNode(node: unknown): DirectiveNode | null {
  if (typeof node !== "object" || node === null) {
    return null;
  }
  const type = (node as { type?: unknown }).type;
  if (type === "textDirective" || type === "leafDirective") {
    return node as DirectiveNode;
  }
  return null;
}

export function remarkMessageDirectives(args: {
  mounts: MountedMessageDirective[];
  registry: MessageDirectiveRegistry;
}) {
  const { mounts, registry } = args;
  return (tree: Nodes, file: RemarkMessageDirectiveFile): void => {
    const markdownSource =
      typeof file.value === "string" ? file.value : String(file.value ?? "");
    mounts.length = 0;
    visit(tree, (node, index, parent: Parent | undefined) => {
      const directive = asDirectiveNode(node);
      if (directive === null || parent === undefined || index === undefined) {
        return;
      }
      const marker = DIRECTIVE_MARKERS[directive.type];
      const name = typeof directive.name === "string" ? directive.name : "";
      const attributes = normalizeDirectiveAttributes(directive.attributes);
      const source = directiveSourceFromNode(
        directive,
        markdownSource,
        name,
        attributes,
        marker,
      );

      if (directive.type !== "leafDirective") {
        return spliceLiteralDirective(parent, index, directive.type, source);
      }

      if (name.length === 0) {
        return spliceLiteralDirective(parent, index, directive.type, source);
      }

      const entry = registry.get(name);
      if (entry === undefined || entry.status === "collision") {
        return spliceLiteralDirective(parent, index, directive.type, source);
      }

      if (mounts.length >= MESSAGE_DIRECTIVE_MOUNT_LIMIT) {
        return spliceLiteralDirective(parent, index, directive.type, source);
      }

      const mountIndex = mounts.length;
      mounts.push({
        attributes,
        index: mountIndex,
        slot: entry.slot,
        source,
      });
      parent.children.splice(index, 1, messageDirectiveMountNode(mountIndex));
      return index;
    });
  };
}

interface BuildMessageDirectiveComponentArgs {
  mounts: readonly MountedMessageDirective[];
  message: PluginMessageDirectiveProps["message"];
  openWorkspaceFile: PluginMessageDirectiveProps["openWorkspaceFile"];
  openThreadPanel: MarkdownMessageDirectiveOpenThreadPanel | null;
}

export function buildMessageDirectiveComponent({
  mounts,
  message,
  openWorkspaceFile,
  openThreadPanel,
}: BuildMessageDirectiveComponentArgs): ComponentType<MessageDirectiveElementProps> {
  function MessageDirectiveElement(props: MessageDirectiveElementProps) {
    const rawIndex = props["data-directive-index"];
    if (rawIndex === undefined) {
      return null;
    }
    const mount = mounts[Number(rawIndex)];
    if (mount === undefined) {
      return null;
    }
    const { slot, attributes, source } = mount;
    const Component = slot.component;
    return (
      <PluginSlotMount
        key={`${slot.pluginId}/${slot.id}/${slot.generation}`}
        pluginId={slot.pluginId}
        slotKind="messageDirective"
        slotId={slot.id}
        crashFallback={source}
      >
        {openThreadPanel === null ? (
          <Component
            attributes={attributes}
            source={source}
            message={message}
            openWorkspaceFile={openWorkspaceFile}
          />
        ) : (
          <PluginThreadPanelNavigationProvider
            openThreadPanel={openThreadPanel}
          >
            <Component
              attributes={attributes}
              source={source}
              message={message}
              openWorkspaceFile={openWorkspaceFile}
            />
          </PluginThreadPanelNavigationProvider>
        )}
      </PluginSlotMount>
    );
  }

  return MessageDirectiveElement;
}

const MessageDirectiveRegistryContext =
  createContext<MessageDirectiveRegistry | null>(null);

export function MessageDirectiveRegistryProvider({
  registry,
  children,
}: {
  registry: MessageDirectiveRegistry;
  children: ReactNode;
}) {
  return (
    <MessageDirectiveRegistryContext.Provider value={registry}>
      {children}
    </MessageDirectiveRegistryContext.Provider>
  );
}

export function useMessageDirectiveRegistry(): MessageDirectiveRegistry | null {
  return useContext(MessageDirectiveRegistryContext);
}
