export function workspaceInitials(label: string | null | undefined): string {
  const words = (label ?? "")
    .split(/[\s\-_./:]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) return "bb";
  const second = words[1];
  if (second === undefined) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + second.charAt(0)).toUpperCase();
}
