import {
  uiMessageSchema,
  uiMessageStatusSchema,
  uiMessageStatusValues,
  type ToUIMessagesOptions,
  type UIAssistantReasoningMessage,
  type UIAssistantTextMessage,
  type UIDebugRawEventMessage,
  type UIErrorMessage,
  type UIFileEditChange,
  type UIFileEditMessage,
  type UIMessage,
  type UIMessageBase,
  type UIMessageStatus,
  type UIOperationMessage,
  type UIProvisioningMetadata,
  type UIProvisioningTranscriptEntry,
  type UIThreadOperationMetadata,
  type UIToolCallMessage,
  type UIToolCallSummary,
  type UIToolExploringMessage,
  type UIToolParsedIntent,
  type UIUserMessage,
  type UIWebSearchMessage,
} from "./ui-message.js";

export const viewMessageStatusValues = uiMessageStatusValues;
export const viewMessageStatusSchema = uiMessageStatusSchema;
export type ViewMessageStatus = UIMessageStatus;

export const viewMessageSchema = uiMessageSchema;
export type ViewMessage = UIMessage;
export type ViewMessageBase = UIMessageBase;
export type ViewUserMessage = UIUserMessage;
export type ViewAssistantTextMessage = UIAssistantTextMessage;
export type ViewAssistantReasoningMessage = UIAssistantReasoningMessage;
export type ViewToolCallMessage = UIToolCallMessage;
export type ViewToolExploringMessage = UIToolExploringMessage;
export type ViewToolCallSummary = UIToolCallSummary;
export type ViewToolParsedIntent = UIToolParsedIntent;
export type ViewWebSearchMessage = UIWebSearchMessage;
export type ViewFileEditMessage = UIFileEditMessage;
export type ViewFileEditChange = UIFileEditChange;
export type ViewOperationMessage = UIOperationMessage;
export type ViewErrorMessage = UIErrorMessage;
export type ViewDebugRawEventMessage = UIDebugRawEventMessage;
export type ViewProvisioningMetadata = UIProvisioningMetadata;
export type ViewProvisioningTranscriptEntry = UIProvisioningTranscriptEntry;
export type ViewThreadOperationMetadata = UIThreadOperationMetadata;
export type ToViewMessagesOptions = ToUIMessagesOptions;
