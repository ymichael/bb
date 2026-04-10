import type { JsonRpcMessage } from "./provider-adapter.js";

export type ProviderRawEventCoverage = "normalized" | "noise" | "unknown";

export type ProviderObservedToolCallCoverage =
  | "well-known"
  | "accepted-fallback"
  | "unknown";

export interface ProviderRawEventDescription {
  kind: string;
  coverage: ProviderRawEventCoverage;
}

export interface ProviderObservedToolCall {
  key: string;
  displayName: string;
  coverage: ProviderObservedToolCallCoverage;
}

export interface ProviderParsedRawEvent {
  kind: string;
}

export interface ProviderVisibilityMetadata<
  TRawEvent extends ProviderParsedRawEvent = ProviderParsedRawEvent,
> {
  providerId: string;
  wellKnownToolNames: readonly string[];
  parseRawEvent(event: JsonRpcMessage): TRawEvent;
  describeParsedRawEvent(event: TRawEvent): ProviderRawEventDescription;
  extractObservedToolCallsFromParsed(event: TRawEvent): ProviderObservedToolCall[];
  describeRawEvent(event: JsonRpcMessage): ProviderRawEventDescription;
  extractObservedToolCalls(event: JsonRpcMessage): ProviderObservedToolCall[];
}

export interface CreateProviderVisibilityMetadataArgs<
  TRawEvent extends ProviderParsedRawEvent,
> {
  providerId: string;
  wellKnownToolNames: readonly string[];
  parseRawEvent(event: JsonRpcMessage): TRawEvent;
  describeParsedRawEvent(event: TRawEvent): ProviderRawEventDescription;
  extractObservedToolCallsFromParsed(event: TRawEvent): ProviderObservedToolCall[];
}

export function createProviderVisibilityMetadata<
  TRawEvent extends ProviderParsedRawEvent,
>(
  args: CreateProviderVisibilityMetadataArgs<TRawEvent>,
): ProviderVisibilityMetadata<TRawEvent> {
  return {
    providerId: args.providerId,
    wellKnownToolNames: args.wellKnownToolNames,
    parseRawEvent: args.parseRawEvent,
    describeParsedRawEvent: args.describeParsedRawEvent,
    extractObservedToolCallsFromParsed: args.extractObservedToolCallsFromParsed,
    describeRawEvent(event) {
      return args.describeParsedRawEvent(args.parseRawEvent(event));
    },
    extractObservedToolCalls(event) {
      return args.extractObservedToolCallsFromParsed(args.parseRawEvent(event));
    },
  };
}
