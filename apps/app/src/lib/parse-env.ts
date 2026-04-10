interface EnvEntry {
  name: string;
  value: string;
}

interface ParseEnvResult {
  entries: EnvEntry[];
  errors: string[];
}

/**
 * Parses .env file content into name/value pairs.
 * Handles comments, quoted values, and basic escape sequences.
 */
export function parseEnvContent(content: string): ParseEnvResult {
  const entries: EnvEntry[] = [];
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines and comments
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      errors.push(`Line ${i + 1}: missing "=" separator`);
      continue;
    }

    const name = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (name === "") {
      errors.push(`Line ${i + 1}: empty variable name`);
      continue;
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      errors.push(
        `Line ${i + 1}: invalid name "${name}" — use letters, numbers, and underscores only`,
      );
      continue;
    }

    // Strip surrounding quotes (skip inline comment stripping for quoted values)
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"));

    if (isQuoted) {
      value = value.slice(1, -1);
    } else {
      // Strip inline comments only for unquoted values
      const commentIndex = value.indexOf(" #");
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trimEnd();
      }
    }

    entries.push({ name, value });
  }

  return { entries, errors };
}

/**
 * Detects whether pasted text looks like .env content
 * (multiple lines with KEY=VALUE patterns).
 */
export function looksLikeEnvContent(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => {
    const trimmed = l.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
  if (lines.length < 2) {
    return false;
  }
  const matchCount = lines.filter((l) => /^[A-Za-z_]\w*\s*=/.test(l)).length;
  return matchCount >= 2;
}
