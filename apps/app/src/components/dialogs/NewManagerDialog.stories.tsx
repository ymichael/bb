import { useState } from "react";
import type { AvailableModel, Host, ProjectSource } from "@bb/domain";
import type { ProjectResponse, SystemProviderInfo } from "@bb/server-contract";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { NewManagerForm } from "./NewManagerDialog";
import {
  HOST_IDS,
  HOST_NAMES,
  PROJECT_IDS,
  makeProject,
} from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/New Manager",
};

// Matches the real NewManagerDialog's DialogContent className so stories
// reproduce its width and child spacing.
const stageClassName = "gap-3 md:max-w-md";

function NewManagerDialogStage(props: {
  providers: SystemProviderInfo[];
  providersAreLoaded: boolean;
  models: readonly AvailableModel[];
  hosts: Host[];
  projectSources: readonly ProjectSource[];
}) {
  return (
    <DialogStage className={stageClassName}>
      <DialogHeader>
        <DialogTitle>New Manager</DialogTitle>
        <DialogDescription>
          A manager is a teammate that coordinates work for you and delegates
          to worker threads.
        </DialogDescription>
      </DialogHeader>
      <ControlledNewManagerForm {...props} />
    </DialogStage>
  );
}

const noop = () => {};
const asyncNoop = async () => {};

const codexProvider: SystemProviderInfo = {
  id: "codex",
  displayName: "Codex",
  available: true,
  capabilities: {
    supportsArchive: true,
    supportsRename: true,
    supportsServiceTier: true,
    supportsUserQuestion: true,
    supportedPermissionModes: ["full"],
  },
};

const claudeProvider: SystemProviderInfo = {
  id: "claude-code",
  displayName: "Claude Code",
  available: true,
  capabilities: {
    supportsArchive: true,
    supportsRename: true,
    supportsServiceTier: false,
    supportsUserQuestion: true,
    supportedPermissionModes: ["full"],
  },
};

const codexModels: readonly AvailableModel[] = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "" },
      { reasoningEffort: "medium", description: "" },
      { reasoningEffort: "high", description: "" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
  },
  {
    id: "gpt-5-pro",
    model: "gpt-5-pro",
    displayName: "GPT-5 Pro",
    description: "",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "" },
      { reasoningEffort: "high", description: "" },
      { reasoningEffort: "xhigh", description: "" },
    ],
    defaultReasoningEffort: "high",
    isDefault: false,
  },
];

const localHost: Host = {
  id: HOST_IDS.local,
  name: HOST_NAMES.local,
  type: "persistent",
  status: "connected",
  lastSeenAt: 0,
  createdAt: 0,
  updatedAt: 0,
};

const remoteHost: Host = {
  id: HOST_IDS.remote,
  name: HOST_NAMES.remote,
  type: "persistent",
  status: "connected",
  lastSeenAt: 0,
  createdAt: 0,
  updatedAt: 0,
};

const projectSources: ProjectSource[] = [
  {
    type: "local_path",
    id: "src_local",
    projectId: PROJECT_IDS.bb,
    hostId: HOST_IDS.local,
    path: "/Users/michael/Projects/bb",
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    type: "local_path",
    id: "src_remote",
    projectId: PROJECT_IDS.bb,
    hostId: HOST_IDS.remote,
    path: "/srv/repos/bb",
    isDefault: false,
    createdAt: 0,
    updatedAt: 0,
  },
];

const isLocalHost = (id: string | null | undefined) => id === HOST_IDS.local;

function ControlledNewManagerForm(props: {
  providers: SystemProviderInfo[];
  providersAreLoaded: boolean;
  models: readonly AvailableModel[];
  hosts: Host[];
  projectSources: readonly ProjectSource[];
}) {
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const projects: readonly ProjectResponse[] = [
    makeProject({ sources: [...props.projectSources] }),
  ];
  return (
    <NewManagerForm
      projectId={PROJECT_IDS.bb}
      projects={projects}
      projectsAreLoaded
      providers={props.providers}
      providersAreLoaded={props.providersAreLoaded}
      hosts={props.hosts}
      isLocalHost={isLocalHost}
      models={props.models}
      selectedProviderId={selectedProviderId}
      onSelectedProviderIdChange={setSelectedProviderId}
      onProjectChange={noop}
      onHire={asyncNoop}
      isHirePending={false}
    />
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="default"
        hint="Codex preselected from multiple providers, models + reasoning available, local host pre-eligible"
      >
        <NewManagerDialogStage
          providers={[codexProvider, claudeProvider]}
          providersAreLoaded
          models={codexModels}
          hosts={[localHost, remoteHost]}
          projectSources={projectSources}
        />
      </StoryRow>
      <StoryRow
        label="loading"
        hint='provider selected but no models yet — slot shows "Loading…"'
      >
        <NewManagerDialogStage
          providers={[codexProvider]}
          providersAreLoaded
          models={[]}
          hosts={[localHost]}
          projectSources={projectSources}
        />
      </StoryRow>
      <StoryRow
        label="no eligible host"
        hint="project has no local_path source for any connected host — host picker shows empty state"
      >
        <NewManagerDialogStage
          providers={[codexProvider]}
          providersAreLoaded
          models={codexModels}
          hosts={[localHost]}
          projectSources={[]}
        />
      </StoryRow>
    </StoryCard>
  );
}
