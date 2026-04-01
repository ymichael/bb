export function buildSandboxDaemonEnv(githubPat: string): Record<string, string> {
  if (githubPat === "") {
    return {};
  }

  return {
    GITHUB_TOKEN: githubPat,
  };
}
