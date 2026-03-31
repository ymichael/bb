import type {
  ThreadEvent,
  ThreadEventItemType,
  ThreadEventType,
} from "@bb/domain";

export interface StoredEventItemFields {
  itemId: string | null;
  itemKind: ThreadEventItemType | null;
}

interface StoredEventItemIdentity {
  id: string;
  type: ThreadEventItemType;
}

export interface StoredEventItemFieldSource {
  item?: StoredEventItemIdentity;
  itemId?: string;
  type: ThreadEventType;
}

function fromItem(args: StoredEventItemIdentity): StoredEventItemFields {
  return {
    itemId: args.id,
    itemKind: args.type,
  };
}

function fromItemId(itemId: string | undefined): StoredEventItemFields {
  return {
    itemId: itemId ?? null,
    itemKind: null,
  };
}

export function deriveStoredEventItemFieldsFromSource(
  source: StoredEventItemFieldSource,
): StoredEventItemFields {
  switch (source.type) {
    case "item/started":
    case "item/completed":
      if (!source.item) {
        throw new Error(`Missing item payload for ${source.type}`);
      }
      return fromItem(source.item);
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "item/toolCall/progress":
      return fromItemId(source.itemId);
    default:
      return {
        itemId: null,
        itemKind: null,
      };
  }
}

export function deriveStoredEventItemFields(
  event: ThreadEvent,
): StoredEventItemFields {
  return deriveStoredEventItemFieldsFromSource({
    type: event.type,
    item: "item" in event ? event.item : undefined,
    itemId: "itemId" in event ? event.itemId : undefined,
  });
}
