import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cloneRemoteUrl,
  cloneScript,
  enrolmentScript,
  providerAuthenticationScript,
  projectClonePath,
  restartSupervisorScript,
  SANDBOX_DATA_DIR,
  shellQuote,
  stopSupervisorScript,
} from "./enrolment.js";
import { NOT_REACHABLE_MESSAGE } from "./enrolment-target.js";

describe("shellQuote", () => {
  it("uses the real bb connect pairing command in setup guidance", () => {
    expect(NOT_REACHABLE_MESSAGE).toContain(
      "bb connect --code <code> --server <server>",
    );
    expect(NOT_REACHABLE_MESSAGE).not.toContain("bb connect pair");
  });
  it("keeps a single quote from ending the quoted word", () => {
    const quoted = shellQuote("it's; rm -rf /");
    expect(quoted).toBe(`'it'\\''s; rm -rf /'`);
  });

  it("neutralises substitution and command separators", () => {
    expect(shellQuote("$(id) `id` && echo x")).toBe("'$(id) `id` && echo x'");
  });
});

describe("enrolmentScript", () => {
  const script = enrolmentScript({
    joinCode: "join-abc",
    hostId: "host_1",
    serverUrl: "https://tunnel.example.com",
    machineCode: null,
    hostName: "Modal sandbox 3f9a",
  });

  it("runs the server's own installer with the flags install.sh declares", () => {
    expect(script).toContain(
      `-o "$installer" -w '%{http_code}' 'https://tunnel.example.com'/install.sh`,
    );
    expect(script).toContain(
      `sh "$installer" --join-code 'join-abc' --host-id 'host_1' --server 'https://tunnel.example.com' --host-daemon-port 38900`,
    );
    expect(script).toContain("export BB_HOST_NAME='Modal sandbox 3f9a'");
  });

  it("passes the bb connect machine code the installer redeems", () => {
    const connected = enrolmentScript({
      joinCode: "join-abc",
      hostId: "host_1",
      serverUrl: "https://acme.getbb.app",
      machineCode: "mc-secret",
      hostName: "Modal sandbox 3f9a",
    });

    expect(connected).toContain(
      `--server 'https://acme.getbb.app' --machine-code 'mc-secret' --host-daemon-port 38900`,
    );
  });

  it("stops with the HTTP status and body when the installer does not download", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-enrolment-"));
    try {
      const fake = join(root, "curl");
      writeFileSync(
        fake,
        [
          "#!/bin/sh",
          'for arg in "$@"; do',
          "  case $prev in -o) out=$arg ;; esac",
          "  prev=$arg",
          "done",
          'printf "bb connect: not found\\n" > "$out"',
          'printf "404"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      const data = join(root, "data");
      const runnable = enrolmentScript({
        joinCode: "join-abc",
        hostId: "host_1",
        serverUrl: "https://ymichael--15222.getbb.app",
        machineCode: null,
        hostName: "Modal sandbox 3f9a",
      }).replace(
        `export BB_DATA_DIR='${SANDBOX_DATA_DIR}'`,
        `export BB_DATA_DIR='${data}'`,
      );

      const result = spawnSync("sh", ["-c", runnable], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("HTTP status 404");
      expect(result.stderr).toContain("bb connect: not found");
      expect(result.stdout).not.toContain("supervisor started");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips the service the installer would register and pins the data dir", () => {
    expect(script).toContain("export BB_INSTALL_SKIP_SERVICE=1");
    expect(script).toContain(`export BB_DATA_DIR='${SANDBOX_DATA_DIR}'`);
  });

  it("replaces the installer's unwatched daemon with a supervised one", () => {
    expect(script).toContain(`kill "$(cat "$BB_DATA_DIR/install-daemon.pid")"`);
    expect(script).toContain(
      'setsid nohup "$BB_DATA_DIR/daemon-supervisor.sh"',
    );
    expect(script).toContain('"$DATA/npm/bin/bb-app" host-daemon');
    expect(script).toContain("--auto-update");
  });

  it("passes a join code full of metacharacters through as one word", () => {
    const joinCode = "a'; touch /pwned; '";
    const hostile = enrolmentScript({
      joinCode,
      hostId: "host_1",
      serverUrl: "https://tunnel.example.com",
      machineCode: null,
      hostName: "Modal sandbox 3f9a",
    });
    const quoted = hostile
      .split("\n")
      .find((line) => line.includes("--join-code"));
    expect(quoted).toBeDefined();
    expect(quoted).toContain(`--join-code ${shellQuote(joinCode)} `);
    expect(
      execFileSync("sh", ["-c", `printf %s ${shellQuote(joinCode)}`], {
        encoding: "utf8",
      }),
    ).toBe(joinCode);
  });
});

describe("cloneScript", () => {
  it("is idempotent and quotes the remote", () => {
    const script = cloneScript({
      remoteUrl: "https://github.com/acme/bb.git",
      path: "/workspace/bb",
      branchName: "bb/fix-the-thing-thr_123",
    });
    expect(script).toContain("if [ -d '/workspace/bb'/.git ]; then");
    expect(script).toContain(
      "git clone --progress 'https://github.com/acme/bb.git' '/workspace/bb'",
    );
  });

  it("creates the branch it was given, and checks it out when it is already there", () => {
    const script = cloneScript({
      remoteUrl: "https://github.com/acme/bb.git",
      path: "/workspace/bb",
      branchName: "bb/fix-the-thing-thr_123",
    });
    expect(script).toContain("cd '/workspace/bb'");
    expect(script).toContain(
      "if git show-ref --verify --quiet refs/heads/'bb/fix-the-thing-thr_123'; then",
    );
    expect(script).toContain("  git checkout 'bb/fix-the-thing-thr_123'");
    expect(script).toContain("  git checkout -b 'bb/fix-the-thing-thr_123'");
  });

  it("uses HTTPS for GitHub SSH remotes so public repositories clone without an SSH key", () => {
    expect(cloneRemoteUrl("git@github.com:get-bb/bb.git")).toBe(
      "https://github.com/get-bb/bb.git",
    );
    expect(cloneRemoteUrl("ssh://git@github.com/get-bb/bb.git")).toBe(
      "https://github.com/get-bb/bb.git",
    );
  });

  it("leaves non-GitHub remotes unchanged", () => {
    expect(cloneRemoteUrl("git@example.com:acme/private.git")).toBe(
      "git@example.com:acme/private.git",
    );
  });
});

describe("providerAuthenticationScript", () => {
  it("authenticates Codex without putting its API key in the command", () => {
    const script = providerAuthenticationScript("codex", {
      OPENAI_API_KEY: "sk-secret",
    });

    expect(script).toContain(
      "printenv OPENAI_API_KEY | codex login --with-api-key",
    );
    expect(script).not.toContain("sk-secret");
  });

  it("prefers a Codex access token and leaves other providers alone", () => {
    expect(
      providerAuthenticationScript("codex", {
        CODEX_ACCESS_TOKEN: "access-secret",
        OPENAI_API_KEY: "sk-secret",
      }),
    ).toContain("codex login --with-access-token");
    expect(
      providerAuthenticationScript("claude-code", {
        ANTHROPIC_API_KEY: "secret",
      }),
    ).toBeNull();
  });
});

describe("projectClonePath", () => {
  it("slugs a name that is not a safe path segment", () => {
    expect(projectClonePath("BB / Core (main)")).toBe(
      "/workspace/bb-core-main",
    );
  });

  it("falls back when nothing survives slugging", () => {
    expect(projectClonePath("///")).toBe("/workspace/project");
  });
});

describe("sandbox supervisor lifecycle", () => {
  it("stops the supervisor process group before a filesystem snapshot", () => {
    const script = stopSupervisorScript();

    expect(script).toContain('kill -TERM "-$pid"');
    expect(script).toContain('rm -f "$data/daemon-supervisor.pid"');
  });

  it("restarts the preserved daemon against the current server URL", () => {
    const script = restartSupervisorScript("https://acme.getbb.app");

    expect(script).toContain('rm -f "$data/daemon-supervisor.pid"');
    expect(script).toContain("SERVER='https://acme.getbb.app' setsid nohup");
    expect(script).toContain('"$data/daemon-supervisor.sh"');
  });
});
