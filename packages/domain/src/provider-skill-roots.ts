export function isAbsoluteProviderSkillRootPath(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  const drive = /^[a-zA-Z]:\//u.exec(normalized);
  const rest = drive ? normalized.slice(drive[0].length) : normalized.slice(1);
  if (!drive && !normalized.startsWith("/")) {
    return false;
  }
  return rest
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isRelativeProviderSkillRootPath(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  return (
    !normalized.startsWith("/") &&
    !/^[a-zA-Z]:\//u.test(normalized) &&
    normalized
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}
