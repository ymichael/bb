import type {
  Host,
  ProjectSource,
  SandboxBackendInfo,
} from "@bb/domain";
import { EnvironmentPickerUI } from "./EnvironmentPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Environment Picker",
};

const mockHosts: Host[] = [
  {
    id: "local",
    name: "Michael’s MacBook Pro",
    type: "persistent",
    status: "connected",
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "mac-mini-studio",
    name: "Mac Studio (office)",
    type: "persistent",
    status: "connected",
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "old-laptop",
    name: "Linux laptop",
    type: "persistent",
    status: "disconnected",
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
  },
];

const mockSandboxBackends: SandboxBackendInfo[] = [
  {
    id: "e2b",
    displayName: "E2B Sandbox",
    capabilities: {
      supportsManagedClone: true,
      supportsManagedWorktree: true,
      supportsSuspend: true,
    },
    available: true,
  },
];

const localProjectSources: readonly ProjectSource[] = [
  { type: "local_path", hostId: "local", path: "/Users/michael/Projects/bb" },
];

const multiHostSources: readonly ProjectSource[] = [
  { type: "local_path", hostId: "local", path: "/Users/michael/Projects/bb" },
  {
    type: "local_path",
    hostId: "mac-mini-studio",
    path: "/Users/michael/projects/bb",
  },
];

const githubProjectSources: readonly ProjectSource[] = [
  ...localProjectSources,
  { type: "github_repo", repoUrl: "https://github.com/example/bb" },
];

const isLocalHost = (id: string | null | undefined) => id === "local";
const noop = () => {};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="local direct" hint="host: local + mode: local">
        <EnvironmentPickerUI
          value="host:local:local"
          onChange={noop}
          projectId="proj_demo"
          sources={localProjectSources}
          hosts={mockHosts}
          sandboxBackends={[]}
          sandboxHostSupported={false}
          isLocalHost={isLocalHost}
        />
      </StoryRow>
      <StoryRow label="muted" hint="prompt-box treatment">
        <EnvironmentPickerUI
          value="host:local:local"
          onChange={noop}
          projectId="proj_demo"
          sources={localProjectSources}
          hosts={mockHosts}
          sandboxBackends={[]}
          sandboxHostSupported={false}
          isLocalHost={isLocalHost}
          muted
        />
      </StoryRow>
      <StoryRow label="local worktree" hint="host: local + mode: worktree">
        <EnvironmentPickerUI
          value="host:local:worktree"
          onChange={noop}
          projectId="proj_demo"
          sources={localProjectSources}
          hosts={mockHosts}
          sandboxBackends={[]}
          sandboxHostSupported={false}
          isLocalHost={isLocalHost}
        />
      </StoryRow>
      <StoryRow label="remote host direct" hint="host: mac-mini-studio + mode: local">
        <EnvironmentPickerUI
          value="host:mac-mini-studio:local"
          onChange={noop}
          projectId="proj_demo"
          sources={multiHostSources}
          hosts={mockHosts}
          sandboxBackends={[]}
          sandboxHostSupported={false}
          isLocalHost={isLocalHost}
        />
      </StoryRow>
      <StoryRow
        label="remote host worktree"
        hint="host: mac-mini-studio + mode: worktree"
      >
        <EnvironmentPickerUI
          value="host:mac-mini-studio:worktree"
          onChange={noop}
          projectId="proj_demo"
          sources={multiHostSources}
          hosts={mockHosts}
          sandboxBackends={[]}
          sandboxHostSupported={false}
          isLocalHost={isLocalHost}
        />
      </StoryRow>
      <StoryRow label="sandbox" hint="GitHub source + sandbox backend">
        <EnvironmentPickerUI
          value="sandbox:e2b"
          onChange={noop}
          projectId="proj_demo"
          sources={githubProjectSources}
          hosts={mockHosts}
          sandboxBackends={mockSandboxBackends}
          sandboxHostSupported
          isLocalHost={isLocalHost}
        />
      </StoryRow>
      <StoryRow label="open menu" hint="defaultOpen + modal=false">
        <EnvironmentPickerUI
          value="host:local:local"
          onChange={noop}
          projectId="proj_demo"
          sources={multiHostSources}
          hosts={mockHosts}
          sandboxBackends={mockSandboxBackends}
          sandboxHostSupported
          isLocalHost={isLocalHost}
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}
