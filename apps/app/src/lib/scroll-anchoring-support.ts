export function supportsScrollAnchoring(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("overflow-anchor", "none")
  );
}
