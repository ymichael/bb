import type { Host } from "@bb/domain";
import { HostPicker } from "./HostPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Host Picker",
};

const localOnly: Host[] = [
  {
    id: "local",
    name: "Michael’s MacBook Pro",
    type: "persistent",
    status: "connected",
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
  },
];

const multipleHosts: Host[] = [
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
    id: "e2b-bb",
    name: "bb-sandbox-thr_qfk8ksbxkk",
    type: "ephemeral",
    status: "connected",
    provider: "e2b",
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "e2b-stale",
    name: "bb-sandbox-thr_5brannp925",
    type: "ephemeral",
    status: "disconnected",
    provider: "e2b",
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
  },
];

const isLocalHost = (id: string | null | undefined) => id === "local";
const noop = () => {};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="local host">
        <HostPicker
          hosts={localOnly}
          eligibleHosts={localOnly}
          selectedHostId="local"
          onChange={noop}
          isLocalHost={isLocalHost}
        />
      </StoryRow>
      <StoryRow label="remote host">
        <HostPicker
          hosts={multipleHosts}
          eligibleHosts={multipleHosts}
          selectedHostId="e2b-bb"
          onChange={noop}
          isLocalHost={isLocalHost}
        />
      </StoryRow>
      <StoryRow label="disconnected" hint="HostStatusBadge connected=false">
        <HostPicker
          hosts={multipleHosts}
          eligibleHosts={multipleHosts}
          selectedHostId="e2b-stale"
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
          selectedHostId="local"
          onChange={noop}
          isLocalHost={isLocalHost}
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}
