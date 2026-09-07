const MAX_LOGGED_SUPPRESSIONS = 3;

const REACT_FIBER_PREFIXES = [
  "__reactFiber$",
  "__reactInternalInstance$",
] as const;

type RemoveChild = <T extends Node>(child: T) => T;
type InsertBefore = <T extends Node>(node: T, child: Node | null) => T;
type ReplaceChild = <T extends Node>(node: Node, child: T) => T;
type AppendChild = <T extends Node>(node: T) => T;
type AppendLike = (...nodes: Array<Node | string>) => void;

interface InstalledGuard {
  restore: () => void;
}

let installed: InstalledGuard | null = null;
let suppressedCount = 0;
let loggedCount = 0;
let refusedMoveCount = 0;
let loggedRefusalCount = 0;
let isolationDepth = 0;
let isolationLabel: string | null = null;

export function foreignDomMutationCount(): number {
  return suppressedCount;
}

export function pluginHostNodeMoveRefusalCount(): number {
  return refusedMoveCount;
}

function describeNode(node: Node): string {
  if (node instanceof Element) {
    const id = node.id ? `#${node.id}` : "";
    const testId = node.getAttribute("data-testid");
    return `<${node.localName}${id}${testId ? `[data-testid=${testId}]` : ""}>`;
  }
  if (node.nodeType === Node.TEXT_NODE) return "#text";
  return `#node(${node.nodeType})`;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function isHierarchyRequestError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "HierarchyRequestError"
  );
}

function isReactHostNode(node: Node): boolean {
  for (const key of Object.getOwnPropertyNames(node)) {
    for (const prefix of REACT_FIBER_PREFIXES) {
      if (key.startsWith(prefix)) return true;
    }
  }
  return false;
}

function recordSuppression(
  operation: "removeChild" | "insertBefore" | "replaceChild",
  node: Node,
  expectedParent: Node,
): void {
  suppressedCount += 1;
  if (loggedCount >= MAX_LOGGED_SUPPRESSIONS) return;
  loggedCount += 1;
  console.warn(
    `[bb] ${operation}: ${describeNode(node)} is no longer a child of ${describeNode(
      expectedParent,
    )}. Something outside React moved or removed it (a browser extension, ` +
      `plugin content script, or page translation is the usual cause); the ` +
      `call was suppressed instead of crashing the app.`,
    { node, expectedParent, actualParent: node.parentNode },
  );
}

function recordRefusedMove(node: Node, attemptedParent: Node): void {
  refusedMoveCount += 1;
  if (loggedRefusalCount >= MAX_LOGGED_SUPPRESSIONS) return;
  loggedRefusalCount += 1;
  const owner =
    isolationLabel === null
      ? "a plugin content script"
      : `plugin "${isolationLabel}"`;
  console.warn(
    `[bb] ${owner} tried to move ${describeNode(node)} out of React's tree. The ` +
      `move was blocked so the app does not crash when that node is later ` +
      `removed or reordered.`,
    { node, attemptedParent, actualParent: node.parentNode },
  );
}

function refusePluginReparent(node: Node, newParent: Node): boolean {
  if (isolationDepth === 0) return false;
  if (node.parentNode === newParent) return false;
  if (!isReactHostNode(node)) return false;
  if (node.parentNode === null && isReactHostNode(newParent)) return false;
  recordRefusedMove(node, newParent);
  return true;
}

function wrapCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
  label: string | null,
): (...args: Args) => Result {
  return (...args: Args) =>
    runWithPluginDomIsolation(() => callback(...args), label ?? undefined);
}

function enterIsolation(label?: string): string | null {
  const previousLabel = isolationLabel;
  isolationDepth += 1;
  if (label !== undefined) isolationLabel = label;
  return previousLabel;
}

function leaveIsolation(previousLabel: string | null): void {
  isolationDepth -= 1;
  isolationLabel = previousLabel;
}

export function runWithPluginDomIsolation<T>(fn: () => T, label?: string): T {
  const previousLabel = enterIsolation(label);
  try {
    return fn();
  } finally {
    leaveIsolation(previousLabel);
  }
}

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function runWithPluginDomIsolationAsync<T>(
  fn: () => T | Promise<T>,
  label?: string,
  signal?: AbortSignal,
): Promise<T> {
  const previousLabel = enterIsolation(label);
  const work = Promise.resolve().then(fn);
  try {
    if (signal === undefined) return await work;
    const winner = await Promise.race([
      work.then((value) => ({ ok: true as const, value })),
      whenAborted(signal).then(() => ({ ok: false as const })),
    ]);
    if (winner.ok) return winner.value;
  } finally {
    leaveIsolation(previousLabel);
  }
  return await work;
}

function filterAppendNodes(
  parent: Node,
  nodes: Array<Node | string>,
): Array<Node | string> {
  if (isolationDepth === 0) return nodes;
  const kept: Array<Node | string> = [];
  for (const node of nodes) {
    if (typeof node !== "string" && refusePluginReparent(node, parent)) {
      continue;
    }
    kept.push(node);
  }
  return kept;
}

export function installForeignDomMutationGuard(): void {
  if (installed !== null || typeof Node !== "function") return;

  const nativeRemoveChild = Node.prototype.removeChild;
  const nativeInsertBefore = Node.prototype.insertBefore;
  const nativeReplaceChild = Node.prototype.replaceChild;
  const nativeAppendChild = Node.prototype.appendChild;
  const nativeElementAppend = Element.prototype.append;
  const nativeElementPrepend = Element.prototype.prepend;
  const nativeElementBefore = Element.prototype.before;
  const nativeElementAfter = Element.prototype.after;
  const nativeElementReplaceWith = Element.prototype.replaceWith;
  const nativeDocumentAppend = Document.prototype.append;
  const nativeDocumentPrepend = Document.prototype.prepend;
  const nativeFragmentAppend = DocumentFragment.prototype.append;
  const nativeFragmentPrepend = DocumentFragment.prototype.prepend;
  const nativeElementReplaceChildren = Element.prototype.replaceChildren;
  const nativeDocumentReplaceChildren = Document.prototype.replaceChildren;
  const nativeFragmentReplaceChildren =
    DocumentFragment.prototype.replaceChildren;
  const nativeInsertAdjacentElement = Element.prototype.insertAdjacentElement;
  const nativeRangeInsertNode =
    typeof Range === "function" ? Range.prototype.insertNode : null;
  const nativeAddEventListener = EventTarget.prototype.addEventListener;
  const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
  const originalSetTimeout = window.setTimeout;
  const nativeSetTimeout = originalSetTimeout.bind(window);
  const originalSetInterval = window.setInterval;
  const nativeSetInterval = originalSetInterval.bind(window);
  const originalQueueMicrotask =
    typeof queueMicrotask === "function" ? queueMicrotask : null;
  const nativeQueueMicrotask =
    originalQueueMicrotask === null
      ? null
      : originalQueueMicrotask.bind(window);
  const NativeMutationObserver =
    typeof MutationObserver === "function" ? MutationObserver : null;
  const listenerWraps = new WeakMap<
    EventListenerOrEventListenerObject,
    EventListenerOrEventListenerObject
  >();

  const guardedRemoveChild: RemoveChild = function removeChild<T extends Node>(
    this: Node,
    child: T,
  ): T {
    if (child.parentNode !== this) {
      recordSuppression("removeChild", child, this);
      return child;
    }
    try {
      nativeRemoveChild.call(this, child);
    } catch (error) {
      if (isNotFoundError(error)) {
        recordSuppression("removeChild", child, this);
        return child;
      }
      throw error;
    }
    return child;
  };

  const guardedInsertBefore: InsertBefore = function insertBefore<
    T extends Node,
  >(this: Node, node: T, child: Node | null): T {
    if (refusePluginReparent(node, this)) return node;
    if (child !== null && child.parentNode !== this) {
      recordSuppression("insertBefore", child, this);
      try {
        nativeInsertBefore.call(this, node, null);
      } catch (error) {
        if (!isNotFoundError(error) && !isHierarchyRequestError(error)) {
          throw error;
        }
      }
      return node;
    }
    try {
      nativeInsertBefore.call(this, node, child);
    } catch (error) {
      if (isNotFoundError(error)) {
        recordSuppression("insertBefore", child ?? node, this);
        return node;
      }
      throw error;
    }
    return node;
  };

  const guardedReplaceChild: ReplaceChild = function replaceChild<
    T extends Node,
  >(this: Node, node: Node, child: T): T {
    if (refusePluginReparent(node, this)) return child;
    if (child.parentNode !== this) {
      recordSuppression("replaceChild", child, this);
      if (node.parentNode !== this && !refusePluginReparent(node, this)) {
        try {
          nativeInsertBefore.call(this, node, null);
        } catch (error) {
          if (!isNotFoundError(error) && !isHierarchyRequestError(error)) {
            throw error;
          }
        }
      }
      return child;
    }
    try {
      nativeReplaceChild.call(this, node, child);
    } catch (error) {
      if (isNotFoundError(error)) {
        recordSuppression("replaceChild", child, this);
        return child;
      }
      throw error;
    }
    return child;
  };

  const guardedAppendChild: AppendChild = function appendChild<T extends Node>(
    this: Node,
    node: T,
  ): T {
    if (refusePluginReparent(node, this)) return node;
    nativeAppendChild.call(this, node);
    return node;
  };

  const guardedParentAppend = (native: AppendLike): AppendLike =>
    function append(this: ParentNode, ...nodes: Array<Node | string>): void {
      const kept = filterAppendNodes(this, nodes);
      if (kept.length === 0) return;
      native.apply(this, kept);
    };

  const guardedAdjacent = (
    native: AppendLike,
    resolveParent: (self: Element) => Node | null,
  ): AppendLike =>
    function adjacent(this: Element, ...nodes: Array<Node | string>): void {
      const parent = resolveParent(this) ?? this;
      const kept = filterAppendNodes(parent, nodes);
      if (kept.length === 0) return;
      native.apply(this, kept);
    };

  Node.prototype.removeChild = guardedRemoveChild;
  Node.prototype.insertBefore = guardedInsertBefore;
  Node.prototype.replaceChild = guardedReplaceChild;
  Node.prototype.appendChild = guardedAppendChild;
  Element.prototype.append = guardedParentAppend(nativeElementAppend);
  Element.prototype.prepend = guardedParentAppend(nativeElementPrepend);
  Element.prototype.before = guardedAdjacent(
    nativeElementBefore,
    (self) => self.parentNode,
  );
  Element.prototype.after = guardedAdjacent(
    nativeElementAfter,
    (self) => self.parentNode,
  );
  Element.prototype.replaceWith = guardedAdjacent(
    nativeElementReplaceWith,
    (self) => self.parentNode,
  );
  Document.prototype.append = guardedParentAppend(nativeDocumentAppend);
  Document.prototype.prepend = guardedParentAppend(nativeDocumentPrepend);
  DocumentFragment.prototype.append = guardedParentAppend(nativeFragmentAppend);
  DocumentFragment.prototype.prepend = guardedParentAppend(
    nativeFragmentPrepend,
  );

  const guardedReplaceChildren = (native: AppendLike): AppendLike =>
    function replaceChildren(
      this: ParentNode,
      ...nodes: Array<Node | string>
    ): void {
      native.apply(this, filterAppendNodes(this, nodes));
    };
  Element.prototype.replaceChildren = guardedReplaceChildren(
    nativeElementReplaceChildren,
  );
  Document.prototype.replaceChildren = guardedReplaceChildren(
    nativeDocumentReplaceChildren,
  );
  DocumentFragment.prototype.replaceChildren = guardedReplaceChildren(
    nativeFragmentReplaceChildren,
  );

  Element.prototype.insertAdjacentElement = function insertAdjacentElement(
    position: InsertPosition,
    element: Element,
  ): Element | null {
    const parent =
      position === "beforebegin" || position === "afterend"
        ? this.parentNode
        : this;
    if (parent !== null && refusePluginReparent(element, parent)) return null;
    return nativeInsertAdjacentElement.call(this, position, element);
  };

  if (nativeRangeInsertNode !== null) {
    Range.prototype.insertNode = function insertNode(node: Node): void {
      const container = this.commonAncestorContainer;
      const parent =
        container.nodeType === Node.TEXT_NODE
          ? container.parentNode
          : container;
      if (parent !== null && refusePluginReparent(node, parent)) return;
      nativeRangeInsertNode.call(this, node);
    };
  }

  function wrapListener(
    listener: EventListenerOrEventListenerObject,
    label: string | null,
  ): EventListenerOrEventListenerObject {
    const existing = listenerWraps.get(listener);
    if (existing !== undefined) return existing;
    const wrapped: EventListenerOrEventListenerObject =
      typeof listener === "function"
        ? wrapCallback(listener, label)
        : {
            handleEvent: (event: Event) =>
              runWithPluginDomIsolation(
                () => listener.handleEvent(event),
                label ?? undefined,
              ),
          };
    listenerWraps.set(listener, wrapped);
    return wrapped;
  }

  EventTarget.prototype.addEventListener = function addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const scheduled =
      isolationDepth > 0 && listener !== null
        ? wrapListener(listener, isolationLabel)
        : listener;
    nativeAddEventListener.call(this, type, scheduled, options);
  };
  EventTarget.prototype.removeEventListener = function removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    const wrapped = listener === null ? undefined : listenerWraps.get(listener);
    nativeRemoveEventListener.call(this, type, listener, options);
    if (wrapped !== undefined && wrapped !== listener) {
      nativeRemoveEventListener.call(this, type, wrapped, options);
    }
  };

  function wrapTimerHandler(
    handler: TimerHandler,
    label: string | null,
  ): TimerHandler {
    if (typeof handler !== "function") return handler;
    return function isolatedTimer(this: unknown, ...cbArgs: unknown[]) {
      return runWithPluginDomIsolation(
        () => Reflect.apply(handler, this, cbArgs),
        label ?? undefined,
      );
    };
  }

  window.setTimeout = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const scheduled =
      isolationDepth > 0 ? wrapTimerHandler(handler, isolationLabel) : handler;
    return nativeSetTimeout(scheduled, timeout, ...args);
  }) as typeof setTimeout;

  window.setInterval = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const scheduled =
      isolationDepth > 0 ? wrapTimerHandler(handler, isolationLabel) : handler;
    return nativeSetInterval(scheduled, timeout, ...args);
  }) as typeof setInterval;

  if (nativeQueueMicrotask !== null) {
    window.queueMicrotask = (callback: VoidFunction) => {
      nativeQueueMicrotask(
        isolationDepth > 0 ? wrapCallback(callback, isolationLabel) : callback,
      );
    };
  }

  if (NativeMutationObserver !== null) {
    window.MutationObserver = class IsolatedMutationObserver extends (
      NativeMutationObserver
    ) {
      constructor(callback: MutationCallback) {
        const label = isolationLabel;
        super(
          isolationDepth > 0
            ? (records, observer) => {
                runWithPluginDomIsolation(
                  () => callback(records, observer),
                  label ?? undefined,
                );
              }
            : callback,
        );
      }
    };
  }

  installed = {
    restore: () => {
      Node.prototype.removeChild = nativeRemoveChild;
      Node.prototype.insertBefore = nativeInsertBefore;
      Node.prototype.replaceChild = nativeReplaceChild;
      Node.prototype.appendChild = nativeAppendChild;
      Element.prototype.append = nativeElementAppend;
      Element.prototype.prepend = nativeElementPrepend;
      Element.prototype.before = nativeElementBefore;
      Element.prototype.after = nativeElementAfter;
      Element.prototype.replaceWith = nativeElementReplaceWith;
      Document.prototype.append = nativeDocumentAppend;
      Document.prototype.prepend = nativeDocumentPrepend;
      DocumentFragment.prototype.append = nativeFragmentAppend;
      DocumentFragment.prototype.prepend = nativeFragmentPrepend;
      Element.prototype.replaceChildren = nativeElementReplaceChildren;
      Document.prototype.replaceChildren = nativeDocumentReplaceChildren;
      DocumentFragment.prototype.replaceChildren =
        nativeFragmentReplaceChildren;
      Element.prototype.insertAdjacentElement = nativeInsertAdjacentElement;
      if (nativeRangeInsertNode !== null) {
        Range.prototype.insertNode = nativeRangeInsertNode;
      }
      EventTarget.prototype.addEventListener = nativeAddEventListener;
      EventTarget.prototype.removeEventListener = nativeRemoveEventListener;
      window.setTimeout = originalSetTimeout;
      window.setInterval = originalSetInterval;
      if (originalQueueMicrotask !== null) {
        window.queueMicrotask = originalQueueMicrotask;
      }
      if (NativeMutationObserver !== null) {
        window.MutationObserver = NativeMutationObserver;
      }
    },
  };
}

export function uninstallForeignDomMutationGuardForTest(): void {
  if (installed !== null) {
    installed.restore();
    installed = null;
  }
  suppressedCount = 0;
  loggedCount = 0;
  refusedMoveCount = 0;
  loggedRefusalCount = 0;
  isolationDepth = 0;
  isolationLabel = null;
}
