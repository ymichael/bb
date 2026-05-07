import { LocalhostBadge } from "./localhost-badge";

export default {
  title: "Primitives/LocalhostBadge",
};

export function Inline() {
  return (
    <div className="flex max-w-md items-center gap-2 p-6 text-sm">
      <span className="truncate">Michael's MacBook Pro</span>
      <LocalhostBadge />
    </div>
  );
}

export function InRows() {
  return (
    <div className="grid max-w-md gap-2 p-6 text-sm">
      <div className="flex items-center justify-between rounded-md border border-border p-3">
        <span>host_local</span>
        <LocalhostBadge />
      </div>
      <div className="flex items-center justify-between rounded-md border border-border p-3">
        <span>host_remote</span>
        <span className="text-xs text-muted-foreground">remote</span>
      </div>
    </div>
  );
}
