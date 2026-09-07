import type { ProjectSource } from "@bb/domain";
import { EnvironmentPickerUI } from "./EnvironmentPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { HOST_IDS, HOST_NAMES, makeHost } from "../../../.ladle/story-fixtures";

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
      <StoryRow label="local direct" hint="selected: Work locally">
        <EnvironmentPickerUI
          value={`host:${HOST_IDS.local}:local`}
          onChange={noop}
          sources={localProjectSources}
          host={localHost}
          isLocal
        />
      </StoryRow>
      <StoryRow label="muted" hint="prompt-box treatment">
        <EnvironmentPickerUI
          value={`host:${HOST_IDS.local}:local`}
          onChange={noop}
          sources={localProjectSources}
          host={localHost}
          isLocal
          muted
        />
      </StoryRow>
      <StoryRow label="local worktree" hint="selected: New worktree">
        <EnvironmentPickerUI
          value={`host:${HOST_IDS.local}:worktree`}
          onChange={noop}
          sources={localProjectSources}
          host={localHost}
          isLocal
        />
      </StoryRow>
      <StoryRow
        label="reuse selected"
        hint="env mode is reuse — button shows 'Reuse worktree'; the specific worktree lives in the adjacent WorktreePicker"
      >
        <EnvironmentPickerUI
          value="reuse"
          onChange={noop}
          sources={localProjectSources}
          host={localHost}
          isLocal
        />
      </StoryRow>
      <StoryRow
        label="no worktrees to reuse"
        hint="reuseDisabled — open the menu to see the 'Existing worktree' row disabled with a hint about why"
      >
        <EnvironmentPickerUI
          value={`host:${HOST_IDS.local}:local`}
          onChange={noop}
          sources={localProjectSources}
          host={localHost}
          isLocal
          reuseDisabled
        />
      </StoryRow>
      <StoryRow
        label="host offline"
        hint="host down with a prior selection — the trigger reads 'Host is offline' (overriding the stale mode); open the menu for the host name and a single 'Host is offline' row, no options"
      >
        <EnvironmentPickerUI
          value={`host:${HOST_IDS.local}:local`}
          onChange={noop}
          sources={localProjectSources}
          host={offlineHost}
          isLocal={false}
          modal={false}
        />
      </StoryRow>
      <StoryRow
        label="remote host (online)"
        hint="viewed from another device: open the menu to see the host name and 'Work remotely' enabled"
      >
        <EnvironmentPickerUI
          value={`host:${HOST_IDS.local}:local`}
          onChange={noop}
          sources={localProjectSources}
          host={remoteHost}
          isLocal={false}
          modal={false}
        />
      </StoryRow>
      <StoryRow
        label="long host"
        hint="open menu wraps the host label inside the menu"
      >
        <EnvironmentPickerUI
          value={`host:${HOST_IDS.local}:local`}
          onChange={noop}
          sources={localProjectSources}
          host={longRemoteHost}
          isLocal={false}
          defaultOpen
          modal={false}
        />
      </StoryRow>
      <StoryRow
        label="open menu"
        hint="defaultOpen + modal=false — local host, online: the full set of options enabled"
      >
        <EnvironmentPickerUI
          value={`host:${HOST_IDS.local}:local`}
          onChange={noop}
          sources={localProjectSources}
          host={localHost}
          isLocal
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
        hint="two hosts viewed from another device (no local daemon) — checkout rows carry a path hint, 'Existing worktree' selected"
      >
        <EnvironmentPickerUI
          value="reuse"
          onChange={noop}
          sources={machineSources}
          host={machineHosts[0] ?? null}
          isLocal={false}
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
