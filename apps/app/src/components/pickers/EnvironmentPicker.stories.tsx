import type { ProjectSource } from "@bb/domain";
import { EnvironmentPickerUI } from "./EnvironmentPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  HOST_IDS,
  HOST_NAMES,
  makeHost,
  STORY_ENVIRONMENT_PROVIDERS,
} from "../../../.ladle/story-fixtures";

const localHost = makeHost({ id: HOST_IDS.local });
const remoteHost = makeHost({ id: HOST_IDS.local, name: "studio-mac-mini" });
const longRemoteHost = makeHost({
  id: HOST_IDS.local,
  name: "studio-mac-mini-with-a-very-long-tailnet-host-name-for-launch-testing",
});
const offlineHost = makeHost({
  id: HOST_IDS.local,
  name: "studio-mac-mini",
  status: "disconnected",
});

export default {
  title: "pickers/Environment Picker",
};

function makeSource(id: string, hostId: string, path: string): ProjectSource {
  return {
    id,
    projectId: "proj_demo",
    type: "local_path",
    hostId,
    path,
    isDefault: id === "src_local",
    createdAt: 0,
    updatedAt: 0,
  };
}

const localProjectSources: readonly ProjectSource[] = [
  makeSource("src_local", HOST_IDS.local, "/Users/michael/Projects/bb"),
];

const noop = () => {};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="local checkout" hint="selected: Project checkout">
        <EnvironmentPickerUI
          value="provider:project-checkout"
          sources={localProjectSources}
          host={localHost}
          isLocal
          providers={STORY_ENVIRONMENT_PROVIDERS}
          selectedProviderHostId={HOST_IDS.local}
          onSelectProvider={noop}
        />
      </StoryRow>
      <StoryRow label="muted" hint="prompt-box treatment">
        <EnvironmentPickerUI
          value="provider:project-checkout"
          sources={localProjectSources}
          host={localHost}
          isLocal
          providers={STORY_ENVIRONMENT_PROVIDERS}
          selectedProviderHostId={HOST_IDS.local}
          onSelectProvider={noop}
          muted
        />
      </StoryRow>
      <StoryRow label="local worktree" hint="selected: New worktree">
        <EnvironmentPickerUI
          value="provider:git-worktree"
          sources={localProjectSources}
          host={localHost}
          isLocal
          providers={STORY_ENVIRONMENT_PROVIDERS}
          onSelectProvider={noop}
        />
      </StoryRow>
      <StoryRow
        label="worktree on an offline host"
        hint="the offline machine outranks the selected provider — the trigger reads 'Host is offline'"
      >
        <EnvironmentPickerUI
          value="provider:git-worktree"
          sources={localProjectSources}
          host={offlineHost}
          isLocal={false}
          providers={STORY_ENVIRONMENT_PROVIDERS}
          onSelectProvider={noop}
          modal={false}
        />
      </StoryRow>
      <StoryRow
        label="reuse selected"
        hint="env mode is reuse — button shows 'Reuse environment'; the specific environment lives in the adjacent ReuseEnvironmentPicker"
      >
        <EnvironmentPickerUI
          value="reuse"
          sources={localProjectSources}
          host={localHost}
          isLocal
        />
      </StoryRow>
      <StoryRow
        label="host offline"
        hint="host down with a prior selection — the trigger reads 'Host is offline' (overriding the stale mode); open the menu for the host name and a single 'Host is offline' row, no options"
      >
        <EnvironmentPickerUI
          value="provider:project-checkout"
          sources={localProjectSources}
          host={offlineHost}
          isLocal={false}
          providers={STORY_ENVIRONMENT_PROVIDERS}
          selectedProviderHostId={HOST_IDS.local}
          onSelectProvider={noop}
          modal={false}
        />
      </StoryRow>
      <StoryRow
        label="remote host (online)"
        hint="viewed from another device: open the menu to see the host name and 'Project checkout' enabled"
      >
        <EnvironmentPickerUI
          value="provider:project-checkout"
          sources={localProjectSources}
          host={remoteHost}
          isLocal={false}
          providers={STORY_ENVIRONMENT_PROVIDERS}
          selectedProviderHostId={HOST_IDS.local}
          onSelectProvider={noop}
          modal={false}
        />
      </StoryRow>
      <StoryRow
        label="long host"
        hint="open menu wraps the host label inside the menu"
      >
        <EnvironmentPickerUI
          value="provider:project-checkout"
          sources={localProjectSources}
          host={longRemoteHost}
          isLocal={false}
          providers={STORY_ENVIRONMENT_PROVIDERS}
          selectedProviderHostId={HOST_IDS.local}
          onSelectProvider={noop}
          defaultOpen
          modal={false}
        />
      </StoryRow>
      <StoryRow
        label="open menu"
        hint="defaultOpen + modal=false — local host, online: the full set of options enabled"
      >
        <EnvironmentPickerUI
          value="provider:project-checkout"
          sources={localProjectSources}
          host={localHost}
          isLocal
          providers={STORY_ENVIRONMENT_PROVIDERS}
          selectedProviderHostId={HOST_IDS.local}
          onSelectProvider={noop}
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}

const machineHosts = [
  makeHost({ id: HOST_IDS.local }),
  makeHost({ id: HOST_IDS.remote, name: HOST_NAMES.remote }),
];

const machineSources: readonly ProjectSource[] = [
  makeSource("src_local", HOST_IDS.local, "/Users/michael/Projects/bb"),
  makeSource("src_remote", HOST_IDS.remote, "/home/michael/bb"),
];

export function MachineMenu() {
  return (
    <StoryCard>
      <StoryRow
        label="machine-grouped menu"
        hint="two hosts viewed from another device (no local daemon) — a checkout row per machine, reuse selected"
      >
        <EnvironmentPickerUI
          value="reuse"
          sources={machineSources}
          host={machineHosts[0] ?? null}
          isLocal={false}
          providers={STORY_ENVIRONMENT_PROVIDERS}
          onSelectProvider={noop}
          machines={{
            hosts: machineHosts,
            localDaemonHostId: null,
            primaryHostId: HOST_IDS.local,
          }}
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}
