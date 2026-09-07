function detectPackageJsonIndent(content) {
  const match = /\n([ \t]+)"/u.exec(content);

  return match === null ? 2 : match[1];
}

export function createUpdatedPackageContent({
  content,
  packageJson,
  newVersion,
}) {
  const trailingNewline = content.endsWith("\n") ? "\n" : "";

  return `${JSON.stringify(
    { ...packageJson, version: newVersion },
    null,
    detectPackageJsonIndent(content),
  )}${trailingNewline}`;
}
