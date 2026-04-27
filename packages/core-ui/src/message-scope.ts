import { threadScope, turnScope } from "@bb/domain";
import type { ThreadEventScope, ViewMessageBase } from "@bb/domain";

export function areThreadEventScopesEqual(
  left: ThreadEventScope,
  right: ThreadEventScope,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "thread") {
    return true;
  }
  return right.kind === "turn" && left.turnId === right.turnId;
}

export function haveCompatibleViewMessageScope(
  left: Pick<ViewMessageBase, "scope">,
  right: Pick<ViewMessageBase, "scope">,
): boolean {
  return areThreadEventScopesEqual(left.scope, right.scope);
}

export function getViewMessageScopeTurnId(
  message: Pick<ViewMessageBase, "scope">,
): string | null {
  return message.scope.kind === "turn" ? message.scope.turnId : null;
}

export function viewMessageTurnScopeFields(
  turnId: string,
): Pick<ViewMessageBase, "scope"> {
  return { scope: turnScope(turnId) };
}

export function viewMessageThreadScopeFields(): Pick<
  ViewMessageBase,
  "scope"
> {
  return { scope: threadScope() };
}
