import type { Host } from "@bb/domain";
import { HostPicker } from "./HostPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  HOST_IDS,
  HOST_NAMES,
  makeHost,
} from "../../../.ladle/story-fixtures";

export default {
  title: "pickers/Host Picker",
};

const localOnly: Host[] = [makeHost()];

const multipleHosts: Host[] = [
  makeHost(),
  makeHost({
    id: "host_e2b_bb",
    name: "bb-sandbox-thr_qfk8ksbxkk",
    type: "ephemeral",
    provider: "e2b",
  }),
  makeHost({
    id: "host_e2b_stale",
    name: "bb-sandbox-thr_5brannp925",
    type: "ephemeral",
    status: "disconnected",
    provider: "e2b",
  }),
];

const isLocalHost = (id: string | null | undefined) => id === HOST_IDS.local;
const noop = () => {};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="local host">
        <HostPicker
          hosts={localOnly}
          eligibleHosts={localOnly}
          selectedHostId={HOST_IDS.local}
          onChange={noop}
          isLocalHost={isLocalHost}
        />
      </StoryRow>
      <StoryRow label={`${HOST_NAMES.local}, remote sandbox selected`}>
        <HostPicker
          hosts={multipleHosts}
          eligibleHosts={multipleHosts}
          selectedHostId="host_e2b_bb"
          onChange={noop}
          isLocalHost={isLocalHost}
        />
      </StoryRow>
      <StoryRow label="disconnected" hint="HostStatusBadge connected=false">
        <HostPicker
          hosts={multipleHosts}
          eligibleHosts={multipleHosts}
          selectedHostId="host_e2b_stale"
          onChange={noop}
          isLocalHost={isLocalHost}
        />
      </StoryRow>
      <StoryRow label="no hosts" hint="eligibleHosts is empty">
        <HostPicker
          hosts={[]}
          eligibleHosts={[]}
          selectedHostId=""
          onChange={noop}
          isLocalHost={isLocalHost}
        />
      </StoryRow>
      <StoryRow label="open menu" hint="defaultOpen + modal=false">
        <HostPicker
          hosts={multipleHosts}
          eligibleHosts={multipleHosts}
          selectedHostId={HOST_IDS.local}
          onChange={noop}
          isLocalHost={isLocalHost}
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}
