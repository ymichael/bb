import type { ManagerTemplateName, PromptInput, ThreadType } from "@bb/domain";
import type {
  CreateThreadRequest,
  EnvironmentArgs,
  ThreadCreateOrigin,
} from "@bb/server-contract";

export interface ThreadCreateServiceRequestInput {
  automationId: string | null;
  environment: EnvironmentArgs;
  input: PromptInput[];
  managerTemplateName: ManagerTemplateName | null;
  model?: CreateThreadRequest["model"];
  origin: ThreadCreateOrigin | null;
  parentThreadId?: string;
  permissionMode?: CreateThreadRequest["permissionMode"];
  projectId: string;
  providerId?: CreateThreadRequest["providerId"];
  reasoningLevel?: CreateThreadRequest["reasoningLevel"];
  serviceTier?: CreateThreadRequest["serviceTier"];
  title?: string;
  type: ThreadType;
}

export interface ThreadCreateServiceRequest extends Omit<
  ThreadCreateServiceRequestInput,
  "providerId"
> {
  providerId: string;
}
