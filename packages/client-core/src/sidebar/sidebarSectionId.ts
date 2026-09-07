export type SidebarSectionId =
  | "pinned"
  | "threads"
  | `project:${string}`
  | `section:${string}`
  | `machine:${string}`;
export type CollapsibleSidebarSectionId = "pinned" | "threads";
