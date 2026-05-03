export interface VisibleTextBuffer {
  pendingChunks: string[];
  pendingLength: number;
  visibleChunks: string[];
  visibleLength: number;
  visibleTextCache: string | null;
}

function appendVisibleSegment(buffer: VisibleTextBuffer, text: string): void {
  if (text.length === 0) {
    return;
  }
  buffer.visibleChunks.push(text);
  buffer.visibleLength += text.length;
  if (buffer.visibleTextCache !== null) {
    buffer.visibleTextCache += text;
  }
}

function movePendingTextToVisible(buffer: VisibleTextBuffer): boolean {
  if (buffer.pendingLength === 0) {
    return false;
  }

  if (buffer.visibleTextCache !== null) {
    buffer.visibleTextCache += buffer.pendingChunks.join("");
  }
  buffer.visibleChunks.push(...buffer.pendingChunks);
  buffer.visibleLength += buffer.pendingLength;
  buffer.pendingChunks = [];
  buffer.pendingLength = 0;
  return true;
}

function buildFullText(buffer: VisibleTextBuffer): string {
  const visibleText = buffer.visibleTextCache ?? buffer.visibleChunks.join("");
  if (buffer.pendingLength === 0) {
    return visibleText;
  }
  return `${visibleText}${buffer.pendingChunks.join("")}`;
}

export function createVisibleTextBuffer(
  text = "",
  flushTrailingPartial = false,
): VisibleTextBuffer {
  const buffer: VisibleTextBuffer = {
    pendingChunks: [],
    pendingLength: 0,
    visibleChunks: [],
    visibleLength: 0,
    visibleTextCache: null,
  };
  setVisibleTextBuffer(buffer, text, flushTrailingPartial);
  return buffer;
}

export function appendVisibleTextBuffer(
  buffer: VisibleTextBuffer,
  delta: string,
): boolean {
  if (delta.length === 0) {
    return false;
  }

  const lastNewlineIndex = delta.lastIndexOf("\n");
  if (lastNewlineIndex === -1) {
    buffer.pendingChunks.push(delta);
    buffer.pendingLength += delta.length;
    return true;
  }

  movePendingTextToVisible(buffer);
  appendVisibleSegment(buffer, delta.slice(0, lastNewlineIndex + 1));

  const trailingPartial = delta.slice(lastNewlineIndex + 1);
  if (trailingPartial.length > 0) {
    buffer.pendingChunks.push(trailingPartial);
    buffer.pendingLength += trailingPartial.length;
  }
  return true;
}

export function setVisibleTextBuffer(
  buffer: VisibleTextBuffer,
  text: string,
  flushTrailingPartial: boolean,
): boolean {
  const previousFullText = buildFullText(buffer);
  const previousVisibleText = getVisibleTextBufferText(buffer) ?? "";

  buffer.pendingChunks = [];
  buffer.pendingLength = 0;
  buffer.visibleChunks = [];
  buffer.visibleLength = 0;
  buffer.visibleTextCache = null;

  if (text.length > 0) {
    if (flushTrailingPartial) {
      buffer.visibleChunks.push(text);
      buffer.visibleLength = text.length;
      buffer.visibleTextCache = text;
    } else {
      const lastNewlineIndex = text.lastIndexOf("\n");
      if (lastNewlineIndex === -1) {
        buffer.pendingChunks.push(text);
        buffer.pendingLength = text.length;
      } else {
        const visibleText = text.slice(0, lastNewlineIndex + 1);
        buffer.visibleChunks.push(visibleText);
        buffer.visibleLength = visibleText.length;
        buffer.visibleTextCache = visibleText;

        const trailingPartial = text.slice(lastNewlineIndex + 1);
        if (trailingPartial.length > 0) {
          buffer.pendingChunks.push(trailingPartial);
          buffer.pendingLength = trailingPartial.length;
        }
      }
    }
  }

  return (
    previousFullText !== text ||
    previousVisibleText !== (getVisibleTextBufferText(buffer) ?? "")
  );
}

export function flushVisibleTextBuffer(buffer: VisibleTextBuffer): boolean {
  return movePendingTextToVisible(buffer);
}

export function getVisibleTextBufferFullLength(
  buffer: VisibleTextBuffer,
): number {
  return buffer.visibleLength + buffer.pendingLength;
}

export function getVisibleTextBufferFullText(
  buffer: VisibleTextBuffer,
): string {
  return buildFullText(buffer);
}

export function getVisibleTextBufferText(
  buffer: VisibleTextBuffer,
): string | undefined {
  if (buffer.visibleLength === 0) {
    return undefined;
  }
  if (buffer.visibleTextCache === null) {
    buffer.visibleTextCache = buffer.visibleChunks.join("");
  }
  return buffer.visibleTextCache;
}
