export const SANDBOX_DATA_DIR = "/opt/bb-machine";
export const SANDBOX_HOST_DAEMON_PORT = 38900;
export const SANDBOX_PROJECTS_DIR = "/workspace";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function projectDirectoryName(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "project";
}

export function projectClonePath(projectName: string): string {
  return `${SANDBOX_PROJECTS_DIR}/${projectDirectoryName(projectName)}`;
}

export function prerequisitesScript(): string {
  return [
    "set -eu",
    "missing=",
    "for tool in node npm git curl make g++; do",
    '  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"',
    "done",
    'if [ -z "$missing" ]; then',
    '  echo "prerequisites already present; skipping apt"',
    "  exit 0",
    "fi",
    'echo "installing missing prerequisites:$missing"',
    "apt-get update -qq",
    "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl git build-essential nodejs npm",
  ].join("\n");
}

export interface EnrolmentScriptArgs {
  joinCode: string;
  hostId: string;
  serverUrl: string;
  machineCode: string | null;
  hostName: string;
}

export function enrolmentScript(args: EnrolmentScriptArgs): string {
  const joinCode = shellQuote(args.joinCode);
  const hostId = shellQuote(args.hostId);
  const serverUrl = shellQuote(args.serverUrl);
  const dataDir = shellQuote(SANDBOX_DATA_DIR);
  const port = String(SANDBOX_HOST_DAEMON_PORT);
  const machineCode =
    args.machineCode === null
      ? ""
      : ` --machine-code ${shellQuote(args.machineCode)}`;
  return [
    "set -eu",
    `export BB_DATA_DIR=${dataDir}`,
    `export BB_HOST_NAME=${shellQuote(args.hostName)}`,
    "export BB_INSTALL_SKIP_SERVICE=1",
    'mkdir -p "$BB_DATA_DIR"',
    'installer="$BB_DATA_DIR/install.sh"',
    "curl_status=0",
    `status=$(curl -sSL --connect-timeout 10 --max-time 300 --retry 2 -o "$installer" -w '%{http_code}' ${serverUrl}/install.sh) || curl_status=$?`,
    'if [ "$curl_status" != "0" ] || [ "$status" != "200" ]; then',
    `  echo "could not download the bb installer from" ${serverUrl}"/install.sh: curl exit $curl_status, HTTP status \${status:-none}" >&2`,
    '  head -n 20 "$installer" >&2 || true',
    "  exit 1",
    "fi",
    `sh "$installer" --join-code ${joinCode} --host-id ${hostId} --server ${serverUrl}${machineCode} --host-daemon-port ${port}`,
    'if [ -f "$BB_DATA_DIR/install-daemon.pid" ]; then',
    '  kill "$(cat "$BB_DATA_DIR/install-daemon.pid")" 2>/dev/null || true',
    '  rm -f "$BB_DATA_DIR/install-daemon.pid"',
    "fi",
    `cat > "$BB_DATA_DIR/daemon-supervisor.sh" <<'BB_SUPERVISOR'`,
    supervisorScript(),
    "BB_SUPERVISOR",
    'chmod +x "$BB_DATA_DIR/daemon-supervisor.sh"',
    `DATA="$BB_DATA_DIR" PORT=${port} SERVER=${serverUrl} setsid nohup "$BB_DATA_DIR/daemon-supervisor.sh" >/dev/null 2>&1 &`,
    'echo "supervisor started"',
  ].join("\n");
}

export function stopSupervisorScript(): string {
  return [
    "set -eu",
    `data=${shellQuote(SANDBOX_DATA_DIR)}`,
    'pid=$(cat "$data/daemon-supervisor.pid" 2>/dev/null || true)',
    'if [ -n "$pid" ]; then',
    '  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
    "fi",
    'rm -f "$data/daemon-supervisor.pid"',
  ].join("\n");
}

export function restartSupervisorScript(serverUrl: string): string {
  return [
    "set -eu",
    `data=${shellQuote(SANDBOX_DATA_DIR)}`,
    'rm -f "$data/daemon-supervisor.pid"',
    `DATA="$data" PORT=${SANDBOX_HOST_DAEMON_PORT} SERVER=${shellQuote(serverUrl)} setsid nohup "$data/daemon-supervisor.sh" >/dev/null 2>&1 &`,
    'echo "supervisor restarted"',
  ].join("\n");
}

function supervisorScript(): string {
  return [
    "#!/bin/sh",
    'echo $$ > "$DATA/daemon-supervisor.pid"',
    'log="$DATA/daemon-supervisor.log"',
    "quick_exits=0",
    "while [ $quick_exits -lt 5 ]; do",
    "  started=$(date +%s)",
    '  BB_APP_NPM_PREFIX="$DATA/npm" BB_DATA_DIR="$DATA" "$DATA/npm/bin/bb-app" host-daemon \\',
    '    --auto-update --host-daemon-port "$PORT" --server-url "$SERVER" >> "$log" 2>&1',
    '  echo "host daemon exited ($?); relaunching" >> "$log"',
    '  [ "$(cat "$DATA/daemon-supervisor.pid" 2>/dev/null)" = "$$" ] || exit 0',
    "  if [ $(($(date +%s) - started)) -ge 60 ]; then",
    "    quick_exits=0",
    "  else",
    "    quick_exits=$((quick_exits + 1))",
    "  fi",
    "  sleep 2",
    "done",
    'echo "host daemon exited 5 times in quick succession; giving up" >> "$log"',
  ].join("\n");
}

export interface CloneScriptArgs {
  remoteUrl: string;
  path: string;
  branchName: string;
}

export function cloneRemoteUrl(remoteUrl: string): string {
  const scpMatch = /^git@github\.com:(.+)$/u.exec(remoteUrl);
  if (scpMatch?.[1]) return `https://github.com/${scpMatch[1]}`;
  try {
    const parsed = new URL(remoteUrl);
    if (
      parsed.protocol === "ssh:" &&
      parsed.hostname === "github.com" &&
      parsed.username === "git"
    ) {
      return `https://github.com${parsed.pathname}`;
    }
  } catch {
    return remoteUrl;
  }
  return remoteUrl;
}

export function providerAuthenticationScript(
  providerId: string,
  environmentVariables: Readonly<Record<string, string>>,
): string | null {
  if (providerId !== "codex") return null;
  if ((environmentVariables.CODEX_ACCESS_TOKEN ?? "").length > 0) {
    return [
      "set -eu",
      "printenv CODEX_ACCESS_TOKEN | codex login --with-access-token",
    ].join("\n");
  }
  if ((environmentVariables.OPENAI_API_KEY ?? "").length > 0) {
    return [
      "set -eu",
      "printenv OPENAI_API_KEY | codex login --with-api-key",
    ].join("\n");
  }
  return null;
}

export function cloneScript(args: CloneScriptArgs): string {
  const remoteUrl = shellQuote(cloneRemoteUrl(args.remoteUrl));
  const path = shellQuote(args.path);
  const branchName = shellQuote(args.branchName);
  return [
    "set -eu",
    `mkdir -p ${shellQuote(SANDBOX_PROJECTS_DIR)}`,
    `if [ -d ${path}/.git ]; then`,
    `  echo "clone already present at" ${path}`,
    "else",
    `  git clone --progress ${remoteUrl} ${path}`,
    "fi",
    `cd ${path}`,
    `if git show-ref --verify --quiet refs/heads/${branchName}; then`,
    `  git checkout ${branchName}`,
    "else",
    `  git checkout -b ${branchName}`,
    "fi",
  ].join("\n");
}

export function shellCommand(script: string): string[] {
  return ["sh", "-c", script];
}
