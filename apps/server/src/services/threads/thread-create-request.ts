import type {
  PromptInput,
  ThreadOriginKind,
  ThreadVisibility,
} from "@bb/domain";
import type {
  CreateThreadEnvironmentArgs,
  CreateThreadRequest,
  EnvironmentArgs,
  StartedOnBehalfOf,
  ThreadCreateOrigin,
} from "@bb/server-contract";

export interface ThreadCreateServiceRequestInput {
  environment: CreateThreadEnvironmentArgs;
  executionInputSources?: CreateThreadRequest["executionInputSources"];
  /**
   * Epoch ms the first message should dispatch at. Present ⇒ the thread is
   * created `pending` with no turn and the first message is queued as a row
   * waiting on the clock.
   */
  sendAt?: CreateThreadRequest["sendAt"];
  input: PromptInput[];
  sectionId?: CreateThreadRequest["sectionId"];
  model?: CreateThreadRequest["model"];
  origin: ThreadCreateOrigin | null;
  originPluginId?: CreateThreadRequest["originPluginId"];
  originKind?: ThreadOriginKind | null;
  parentThreadId?: string;
  permissionMode?: CreateThreadRequest["permissionMode"];
  projectId: string;
  providerId?: CreateThreadRequest["providerId"];
  reasoningLevel?: CreateThreadRequest["reasoningLevel"];
  serviceTier?: CreateThreadRequest["serviceTier"];
  sourceSeqEnd?: CreateThreadRequest["sourceSeqEnd"];
  sourceThreadId?: string;
  startedOnBehalfOf: StartedOnBehalfOf | null;
  title?: string;
  visibility?: ThreadVisibility;
}

export interface ThreadCreateServiceRequest extends Omit<
  ThreadCreateServiceRequestInput,
  "environment" | "providerId"
> {
  environment: EnvironmentArgs;
  providerId: string;
  titleFallback: string | null;
  visibility: ThreadVisibility;
}
