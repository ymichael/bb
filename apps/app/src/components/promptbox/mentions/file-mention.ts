export interface ActiveFileMention {
  query: string;
  start: number;
  end: number;
}

const FILE_MENTION_PATTERN = /(^|[\s([{])@([^\s@]*)$/;

export function findActiveFileMention(
  value: string,
  caretPosition: number,
): ActiveFileMention | null {
  if (caretPosition < 0 || caretPosition > value.length) return null;

  const prefix = value.slice(0, caretPosition);
  const match = FILE_MENTION_PATTERN.exec(prefix);
  if (!match) return null;

  const query = match[2] ?? "";
  const start = prefix.length - query.length - 1;
  if (start < 0 || prefix[start] !== "@") return null;

  return {
    query,
    start,
    end: caretPosition,
  };
}

export function insertFileMention(
  value: string,
  mention: ActiveFileMention,
  filePath: string,
): { value: string; caretPosition: number } {
  const safePath = filePath.trim();
  if (!safePath) {
    return { value, caretPosition: mention.end };
  }

  const suffix = value.slice(mention.end);
  const mentionText = /^\s|$/.test(suffix) ? `@${safePath}` : `@${safePath} `;
  const nextValue = `${value.slice(0, mention.start)}${mentionText}${suffix}`;
  const caretPosition = mention.start + mentionText.length;

  return {
    value: nextValue,
    caretPosition,
  };
}
