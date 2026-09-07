import {
  BbHttpError,
  BbRequestTimeoutError,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
  createNodeBbSdk,
  type BbSdk,
  type CreateNodeBbSdkArgs,
} from "@bb/sdk/node";
import type {
  BbRealtimeSubscribeArgs,
  BbRealtimeSocket,
  BbRealtimeSocketFactory,
  BbRealtimeSocketMessageEvent,
  ThreadGetResult,
  ThreadStatusArgs,
} from "@bb/sdk/node";

export {
  BbHttpError,
  BbRequestTimeoutError,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
};
export type * from "@bb/sdk/node";
export type {
  JsonValue,
  PermissionMode,
  PromptInput,
  PromptTextMention,
  ReasoningLevel,
  ServiceTier,
  ThreadStatus,
} from "@bb/sdk/node";
export type {
  BaseBranchSpec,
  CreateExecutionInputSources,
  EnvironmentArgs,
  ExistingThreadExecutionInputSources,
  UnmanagedBranchSpec,
  WorkspaceArgs,
} from "@bb/sdk/node";
export type { CallerExecutionInputSource as ExecutionInputSource } from "@bb/sdk/node";

export type BBSdkOptions = CreateNodeBbSdkArgs;
export type BBSdkRealtimeSubscribeArgs = BbRealtimeSubscribeArgs;
export type BBSdkRealtimeSocket = BbRealtimeSocket;
export type BBSdkRealtimeSocketFactory = BbRealtimeSocketFactory;
export type BBSdkRealtimeSocketMessageEvent = BbRealtimeSocketMessageEvent;
export type BBSdkStatusArea = BbSdk["status"];
export type BBSdkSkillsArea = BbSdk["skills"];
export type BBSdkTerminalsArea = BbSdk["terminals"];
export type BBSdkThread = ThreadGetResult;
export type BBSdkThreadsArea = BbSdk["threads"];
export type ThreadIdArgs = ThreadStatusArgs;
export type BbHttpErrorConstructor = typeof BbHttpError;
export type BbRequestTimeoutErrorConstructor = typeof BbRequestTimeoutError;
export type ThreadWaitTimeoutErrorConstructor = typeof ThreadWaitTimeoutError;
export type ThreadWaitUnreachableErrorConstructor =
  typeof ThreadWaitUnreachableError;

export class BBSdk implements BbSdk {
  readonly environments: BbSdk["environments"];
  readonly experimental_desktopBrowsers: BbSdk["experimental_desktopBrowsers"];
  readonly files: BbSdk["files"];
  readonly guide: BbSdk["guide"];
  readonly hosts: BbSdk["hosts"];
  readonly plugins: BbSdk["plugins"];
  readonly projects: BbSdk["projects"];
  readonly providers: BbSdk["providers"];
  readonly skills: BbSdk["skills"];
  readonly status: BbSdk["status"];
  readonly system: BbSdk["system"];
  readonly terminals: BbSdk["terminals"];
  readonly theme: BbSdk["theme"];
  readonly threadSections: BbSdk["threadSections"];
  readonly threads: BbSdk["threads"];
  readonly subscribe: BbSdk["subscribe"];

  constructor(options: BBSdkOptions = {}) {
    const sdk = createNodeBbSdk(options);
    this.environments = sdk.environments;
    this.experimental_desktopBrowsers = sdk.experimental_desktopBrowsers;
    this.files = sdk.files;
    this.guide = sdk.guide;
    this.hosts = sdk.hosts;
    this.plugins = sdk.plugins;
    this.projects = sdk.projects;
    this.providers = sdk.providers;
    this.skills = sdk.skills;
    this.status = sdk.status;
    this.system = sdk.system;
    this.terminals = sdk.terminals;
    this.theme = sdk.theme;
    this.threadSections = sdk.threadSections;
    this.threads = sdk.threads;
    this.subscribe = sdk.subscribe;
  }
}

export function createBBSdk(options: BBSdkOptions = {}): BBSdk {
  return new BBSdk(options);
}
