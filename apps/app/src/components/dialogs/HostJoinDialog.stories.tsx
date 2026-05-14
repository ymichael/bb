import type { CreateHostJoinResponse } from "@bb/server-contract";
import { HostJoinAppUrlRequiredDialogContent } from "./HostJoinAppUrlRequiredDialog";
import { HostJoinDialogContent } from "./HostJoinDialog";
import { HOST_IDS, HOST_NAMES, makeHost } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Host Join",
};

const pendingTarget: CreateHostJoinResponse = {
  expiresAt: Date.now() + 15 * 60 * 1_000,
  hostId: HOST_IDS.remote,
  joinCode: "bbde_story_join_code",
  joinCommand:
    "BB_SERVER_URL='http://server-machine.example-tailnet.ts.net:38886' BB_HOST_ID='host_remote' BB_HOST_TYPE='persistent' BB_HOST_ENROLL_KEY='bbde_story_join_code_with_a_long_wrapping_token_value' pnpm start:host-daemon",
};

const connectedTarget: CreateHostJoinResponse = {
  ...pendingTarget,
  joinCode: "bbde_connected_story_join_code",
};

const expiredTarget: CreateHostJoinResponse = {
  ...pendingTarget,
  expiresAt: Date.now() - 1_000,
  joinCode: "bbde_expired_story_join_code",
};

const waitingHost = makeHost({
  id: HOST_IDS.remote,
  name: "pending-remote",
  status: "disconnected",
});

const connectedHost = makeHost({
  id: HOST_IDS.remote,
  name: HOST_NAMES.remote,
  status: "connected",
});

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="waiting" hint="join command ready for remote host">
        <DialogStage className="sm:max-w-2xl">
          <HostJoinDialogContent host={waitingHost} target={pendingTarget} />
        </DialogStage>
      </StoryRow>
      <StoryRow label="expired" hint="join command is no longer valid">
        <DialogStage className="sm:max-w-2xl">
          <HostJoinDialogContent host={waitingHost} target={expiredTarget} />
        </DialogStage>
      </StoryRow>
      <StoryRow label="connected" hint="daemon has opened a host session">
        <DialogStage className="sm:max-w-2xl">
          <HostJoinDialogContent host={connectedHost} target={connectedTarget} />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="app-url-required"
        hint="separate dialog shown when BB_APP_URL is unset"
      >
        <DialogStage className="sm:max-w-2xl">
          <HostJoinAppUrlRequiredDialogContent />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
