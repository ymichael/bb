import { useState } from "react";
import type { AvailableModel, Host, ProjectSource } from "@bb/domain";
import type { SystemProviderInfo } from "@bb/server-contract";
import { HireManagerDialogContent } from "./HireManagerDialog";
import {
  HOST_IDS,
  HOST_NAMES,
  PROJECT_IDS,
} from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Hire Manager",
};

const noop = () => {};
const asyncNoop = async () => {};

// Matches the dialog's custom DialogContent className: tight border, no padding,
// 34rem width. The form owns its own inset.
const stageClassName =
  "max-w-[34rem] gap-0 overflow-hidden border-border/80 p-0 shadow-xl";

const codexProvider: SystemProviderInfo = {
  id: "codex",
  displayName: "Codex",
  available: true,
  capabilities: {
    supportsArchive: true,
    supportsRename: true,
    supportsServiceTier: true,
    supportedPermissionModes: ["default"],
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
    supportedPermissionModes: ["default"],
  },
};

const codexModels: readonly AvailableModel[] = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
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
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
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

const projectSources: readonly ProjectSource[] = [
  {
    type: "local_path",
    id: "src_local",
    hostId: HOST_IDS.local,
    path: "/Users/michael/Projects/bb",
  },
  {
    type: "local_path",
    id: "src_remote",
    hostId: HOST_IDS.remote,
    path: "/srv/repos/bb",
  },
];

const isLocalHost = (id: string | null | undefined) => id === HOST_IDS.local;

function ControlledHireManagerDialogContent(props: {
  providers: SystemProviderInfo[];
  providersAreLoaded: boolean;
  models: readonly AvailableModel[];
  hosts: Host[];
  projectSources: readonly ProjectSource[];
}) {
  const [selectedProviderId, setSelectedProviderId] = useState("");
  return (
    <HireManagerDialogContent
      projectId={PROJECT_IDS.bb}
      projectSources={props.projectSources}
      providers={props.providers}
      providersAreLoaded={props.providersAreLoaded}
      hosts={props.hosts}
      isLocalHost={isLocalHost}
      models={props.models}
      selectedProviderId={selectedProviderId}
      onSelectedProviderIdChange={setSelectedProviderId}
      onHire={asyncNoop}
    />
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="default"
        hint="Codex provider preselected, models + reasoning available, local host pre-eligible"
      >
        <DialogStage className={stageClassName}>
          <ControlledHireManagerDialogContent
            providers={[codexProvider]}
            providersAreLoaded
            models={codexModels}
            hosts={[localHost]}
            projectSources={projectSources}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="multiple providers"
        hint="Provider picker has a chooser; Codex selected by default"
      >
        <DialogStage className={stageClassName}>
          <ControlledHireManagerDialogContent
            providers={[codexProvider, claudeProvider]}
            providersAreLoaded
            models={codexModels}
            hosts={[localHost, remoteHost]}
            projectSources={projectSources}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="providers loading"
        hint='providersAreLoaded=false — model slot shows "Loading providers…"'
      >
        <DialogStage className={stageClassName}>
          <ControlledHireManagerDialogContent
            providers={[]}
            providersAreLoaded={false}
            models={[]}
            hosts={[localHost]}
            projectSources={projectSources}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="no providers"
        hint='providers resolved empty — model slot shows "No providers available"'
      >
        <DialogStage className={stageClassName}>
          <ControlledHireManagerDialogContent
            providers={[]}
            providersAreLoaded
            models={[]}
            hosts={[localHost]}
            projectSources={projectSources}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="models loading"
        hint='provider selected but no models yet — slot shows "Loading models…"'
      >
        <DialogStage className={stageClassName}>
          <ControlledHireManagerDialogContent
            providers={[codexProvider]}
            providersAreLoaded
            models={[]}
            hosts={[localHost]}
            projectSources={projectSources}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="no eligible host"
        hint="project has no local_path source for any connected host — host picker shows empty state"
      >
        <DialogStage className={stageClassName}>
          <ControlledHireManagerDialogContent
            providers={[codexProvider]}
            providersAreLoaded
            models={codexModels}
            hosts={[localHost]}
            projectSources={[]}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
