import { z } from "zod";
import {
  promptMentionResourceSchema,
  type PromptMentionResource,
} from "@bb/domain";
import { PLUGIN_MENTION_TRIGGER_VALUES } from "@bb/client-core";

const PROMPT_MENTION_CLIPBOARD_RESOURCE_ATTR = "data-prompt-mention-resource";
const PROMPT_MENTION_CLIPBOARD_SERIALIZED_TEXT_ATTR =
  "data-prompt-mention-serialized-text";

interface PromptMentionClipboardPayload {
  resource: PromptMentionResource;
  serializedText: string;
}

interface PromptMentionClipboardDataAttributes {
  "data-prompt-mention": "true";
  "data-prompt-mention-resource": string;
  "data-prompt-mention-serialized-text": string;
}

interface PromptMentionClipboardDataAttributesArgs {
  resource: PromptMentionResource;
  serializedText: string;
}

interface ParsePromptMentionClipboardElementArgs {
  element: Element;
}

const promptMentionClipboardResourcePayloadSchema = z.object({
  resource: promptMentionResourceSchema,
});

function parseJsonAttribute(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function promptMentionClipboardDataAttributes(
  args: PromptMentionClipboardDataAttributesArgs,
): PromptMentionClipboardDataAttributes {
  return {
    "data-prompt-mention": "true",
    [PROMPT_MENTION_CLIPBOARD_RESOURCE_ATTR]: JSON.stringify(args.resource),
    [PROMPT_MENTION_CLIPBOARD_SERIALIZED_TEXT_ATTR]: args.serializedText,
  };
}

export function promptMentionClipboardContent(
  resource: PromptMentionResource,
): { text: string; html: string } {
  const serializedText = serializedTextForPromptMentionResource(resource);
  const element = document.createElement("span");
  for (const [name, value] of Object.entries(
    promptMentionClipboardDataAttributes({ resource, serializedText }),
  )) {
    element.setAttribute(name, value);
  }
  element.textContent = serializedText;
  return {
    text: `${serializedText} `,
    html: `${element.outerHTML} `,
  };
}

export function serializedTextForPromptMentionResource(
  resource: PromptMentionResource,
): string {
  if (resource.kind === "thread") {
    return `@thread:${resource.threadId}`;
  }
  if (resource.kind === "project") {
    return `@project:${resource.projectId}`;
  }
  if (resource.kind === "section") {
    return `@section:${resource.sectionId}`;
  }
  if (resource.kind === "command") {
    return `${resource.trigger}${resource.name}`;
  }
  if (resource.kind === "plugin") {
    return `@${resource.label}`;
  }

  const sourceQualifiedPath =
    resource.source === "thread-storage"
      ? `thread-storage:${resource.path}`
      : resource.path;
  const directorySuffix =
    resource.entryKind === "directory" && !sourceQualifiedPath.endsWith("/")
      ? "/"
      : "";
  return `@${sourceQualifiedPath}${directorySuffix}`;
}

function isSerializedPluginMentionText(
  resource: Extract<PromptMentionResource, { kind: "plugin" }>,
  serializedText: string,
): boolean {
  if (serializedText === resource.label) {
    return PLUGIN_MENTION_TRIGGER_VALUES.some((trigger) =>
      resource.label.startsWith(trigger),
    );
  }
  return PLUGIN_MENTION_TRIGGER_VALUES.some(
    (trigger) => serializedText === `${trigger}${resource.label}`,
  );
}

function serializedTextForClipboardPayload(
  resource: PromptMentionResource,
  serializedText: string,
): string | null {
  if (resource.kind === "plugin") {
    return isSerializedPluginMentionText(resource, serializedText)
      ? serializedText
      : null;
  }

  return serializedTextForPromptMentionResource(resource);
}

export function parsePromptMentionClipboardElement({
  element,
}: ParsePromptMentionClipboardElementArgs): PromptMentionClipboardPayload | null {
  if (element.getAttribute("data-prompt-mention") !== "true") {
    return null;
  }

  const serializedText = element.getAttribute(
    PROMPT_MENTION_CLIPBOARD_SERIALIZED_TEXT_ATTR,
  );
  const resourceJson = element.getAttribute(
    PROMPT_MENTION_CLIPBOARD_RESOURCE_ATTR,
  );
  if (!serializedText || !resourceJson) {
    return null;
  }

  const parsedResource = parseJsonAttribute(resourceJson);
  const result = promptMentionClipboardResourcePayloadSchema.safeParse({
    resource: parsedResource,
  });
  if (!result.success) {
    return null;
  }
  const normalizedSerializedText = serializedTextForClipboardPayload(
    result.data.resource,
    serializedText,
  );
  if (normalizedSerializedText === null) {
    return null;
  }

  return {
    resource: result.data.resource,
    serializedText: normalizedSerializedText,
  };
}
