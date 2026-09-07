import type {
  ExperimentalDesktopBrowserHostRequest,
  ExperimentalDesktopBrowserScope,
  ExperimentalDesktopBrowserCreateInput,
  ExperimentalDesktopBrowserAcquireInput,
  ExperimentalDesktopBrowserTabRequest,
  ExperimentalDesktopBrowserLeaseRequest,
  ExperimentalDesktopBrowserInstances,
  ExperimentalDesktopBrowserTabs,
  ExperimentalDesktopBrowserCreated,
  ExperimentalDesktopBrowserCapture,
  ExperimentalDesktopBrowserConnection,
  ExperimentalDesktopBrowserLease,
} from "@bb/server-contract";
import type { CreateSdkAreaArgs } from "./common.js";

export type {
  ExperimentalDesktopBrowserHostRequest,
  ExperimentalDesktopBrowserScope,
  ExperimentalDesktopBrowserCreateInput,
  ExperimentalDesktopBrowserAcquireInput,
  ExperimentalDesktopBrowserTabRequest,
  ExperimentalDesktopBrowserLeaseRequest,
  ExperimentalDesktopBrowserInstances,
  ExperimentalDesktopBrowserTabs,
  ExperimentalDesktopBrowserCreated,
  ExperimentalDesktopBrowserCapture,
  ExperimentalDesktopBrowserConnection,
  ExperimentalDesktopBrowserLease,
} from "@bb/server-contract";

export interface ExperimentalDesktopBrowsersArea {
  listInstances(
    input: ExperimentalDesktopBrowserHostRequest,
  ): Promise<ExperimentalDesktopBrowserInstances>;
  listTabs(
    input: ExperimentalDesktopBrowserScope,
  ): Promise<ExperimentalDesktopBrowserTabs>;
  createTab(
    input: ExperimentalDesktopBrowserCreateInput,
  ): Promise<ExperimentalDesktopBrowserCreated>;
  acquireControl(
    input: ExperimentalDesktopBrowserAcquireInput,
  ): Promise<ExperimentalDesktopBrowserLease>;
  openConnection(
    input: ExperimentalDesktopBrowserLeaseRequest,
  ): Promise<ExperimentalDesktopBrowserConnection>;
  releaseControl(
    input: ExperimentalDesktopBrowserLeaseRequest,
  ): Promise<{ ok: true }>;
  revealTab(input: ExperimentalDesktopBrowserTabRequest): Promise<{ ok: true }>;
  closeTab(input: ExperimentalDesktopBrowserTabRequest): Promise<{ ok: true }>;
  captureTab(
    input: ExperimentalDesktopBrowserTabRequest,
  ): Promise<ExperimentalDesktopBrowserCapture>;
  subscribe(
    input: ExperimentalDesktopBrowserScope & {
      onChange: (result: ExperimentalDesktopBrowserTabs) => void;
      onError: (error: Error) => void;
    },
  ): { dispose(): void };
}

export function createDesktopBrowsersArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalDesktopBrowsersArea {
  const api = () => transport.api.v1["desktop-browsers"];
  const listTabs = (input: ExperimentalDesktopBrowserScope) =>
    transport.readJson(api().tabs.$post({ json: input }));
  return {
    listInstances: (input) =>
      transport.readJson(api().instances.$post({ json: input })),
    listTabs,
    createTab: (input) =>
      transport.readJson(api().create.$post({ json: input })),
    acquireControl: (input) =>
      transport.readJson(api().acquire.$post({ json: input })),
    openConnection: (input) =>
      transport.readJson(api().connection.$post({ json: input })),
    releaseControl: (input) =>
      transport.readJson(api().release.$post({ json: input })),
    revealTab: (input) =>
      transport.readJson(api().reveal.$post({ json: input })),
    closeTab: (input) => transport.readJson(api().close.$post({ json: input })),
    captureTab: (input) =>
      transport.readJson(api().capture.$post({ json: input })),
    subscribe(input) {
      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let previous = "";
      const scope: ExperimentalDesktopBrowserScope = {
        hostId: input.hostId,
        instanceId: input.instanceId,
        generation: input.generation,
        threadId: input.threadId,
      };
      const poll = async () => {
        try {
          const result = await listTabs(scope);
          const serialized = JSON.stringify(result);
          if (!disposed && serialized !== previous) {
            previous = serialized;
            input.onChange(result);
          }
        } catch (error) {
          if (!disposed)
            input.onError(
              error instanceof Error ? error : new Error(String(error)),
            );
        } finally {
          if (!disposed)
            timer = setTimeout(() => {
              void poll();
            }, 2000);
        }
      };
      void poll();
      return {
        dispose() {
          disposed = true;
          clearTimeout(timer);
        },
      };
    },
  };
}
