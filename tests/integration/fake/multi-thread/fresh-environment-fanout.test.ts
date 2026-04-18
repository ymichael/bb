import fs from "node:fs/promises";
import path from "node:path";
import { createFakeAdapter } from "@bb/agent-runtime/test";
import { shellSingleQuote, waitForSetupMarkerCount } from "@bb/test-helpers";
import { describe, expect, it } from "vitest";
import {
  createHostThread,
  getThreadEvents,
  getThreadOutput,
} from "../../helpers/api.js";
import { waitForThreadStatus } from "../../helpers/assertions.js";
import { createProjectFixture } from "../../helpers/fixtures.js";
import { withHarness } from "../../helpers/harness.js";
import { createTestGitRepo } from "../../helpers/seed.js";
import { DEFAULT_TIMEOUT_MS } from "./shared.js";

const FANOUT_PROVIDERS: ReadonlyArray<string> = ["codex", "claude-code", "pi"];
const THREADS_PER_PROVIDER = 5;

describe.sequential(
  "fake provider fresh-environment fanout integration",
  () => {
    it("runs same-source managed worktree setup scripts concurrently", () =>
      withHarness(async (harness) => {
        const coordinationDir = path.join(
          path.dirname(harness.repoDir),
          "setup-coordination",
        );
        const markerDir = path.join(coordinationDir, "markers");
        const releaseFile = path.join(coordinationDir, "release");
        const sourceRepo = await createTestGitRepo({
          repoDir: path.join(path.dirname(harness.repoDir), "setup-project"),
          files: [
            {
              relativePath: "README.md",
              content: "setup project\n",
            },
            {
              relativePath: ".bb-env-setup.sh",
              content:
                [
                  "set -euo pipefail",
                  `marker_dir=${shellSingleQuote(markerDir)}`,
                  `release_file=${shellSingleQuote(releaseFile)}`,
                  'marker_name="$(basename "$(dirname "$PWD")")-$(basename "$PWD")"',
                  'mkdir -p "$marker_dir"',
                  'touch "$marker_dir/started-$marker_name"',
                  'while [ ! -f "$release_file" ]; do sleep 0.05; done',
                  "echo setup released",
                ].join("\n") + "\n",
            },
          ],
        });
        const project = await createProjectFixture(harness, {
          name: "Concurrent Setup Fanout",
          path: sourceRepo,
        });

        const [firstThread, secondThread] = await Promise.all([
          createHostThread(harness.api, {
            hostId: harness.hostId,
            input: [{ type: "text", text: "first concurrent setup" }],
            projectId: project.id,
            providerId: "codex",
            workspace: { type: "managed-worktree" },
          }),
          createHostThread(harness.api, {
            hostId: harness.hostId,
            input: [{ type: "text", text: "second concurrent setup" }],
            projectId: project.id,
            providerId: "claude-code",
            workspace: { type: "managed-worktree" },
          }),
        ]);

        try {
          await expect(
            waitForSetupMarkerCount({
              markerDir,
              expectedCount: 2,
              timeoutMs: DEFAULT_TIMEOUT_MS,
            }),
          ).resolves.toHaveLength(2);
        } finally {
          await fs.writeFile(releaseFile, "release\n", "utf8");
        }

        await Promise.all([
          waitForThreadStatus(
            harness.api,
            firstThread.id,
            "idle",
            DEFAULT_TIMEOUT_MS,
          ),
          waitForThreadStatus(
            harness.api,
            secondThread.id,
            "idle",
            DEFAULT_TIMEOUT_MS,
          ),
        ]);
        expect(await getThreadOutput(harness.api, firstThread.id)).toContain(
          "first concurrent setup",
        );
        expect(await getThreadOutput(harness.api, secondThread.id)).toContain(
          "second concurrent setup",
        );
      }));

    it("starts five fresh managed-worktree threads per provider concurrently", () =>
      withHarness(
        {
          adapterFactory: (providerId) =>
            createFakeAdapter({
              displayName: providerId,
              id: providerId,
            }),
        },
        async (harness) => {
          const project = await createProjectFixture(harness, {
            name: "Fresh Environment Fanout",
          });
          const requests = FANOUT_PROVIDERS.flatMap((providerId) =>
            Array.from({ length: THREADS_PER_PROVIDER }, (_, index) => ({
              index: index + 1,
              providerId,
            })),
          );

          const spawned = await Promise.all(
            requests.map(async (request) => {
              const token = `${request.providerId}-fresh-${request.index}`;
              const thread = await createHostThread(harness.api, {
                hostId: harness.hostId,
                input: [{ type: "text", text: token }],
                projectId: project.id,
                providerId: request.providerId,
                workspace: { type: "managed-worktree" },
              });
              return { ...request, thread, token };
            }),
          );

          const readyThreads = await Promise.all(
            spawned.map(async (entry) => ({
              ...entry,
              thread: await waitForThreadStatus(
                harness.api,
                entry.thread.id,
                "idle",
                DEFAULT_TIMEOUT_MS,
              ),
            })),
          );

          for (const entry of readyThreads) {
            expect(entry.thread.environmentId).toBeTruthy();
            const output = await getThreadOutput(harness.api, entry.thread.id);
            if (!output?.includes(entry.token)) {
              const events = await getThreadEvents(
                harness.api,
                entry.thread.id,
              );
              throw new Error(
                [
                  `Missing output for ${entry.thread.id}`,
                  `provider=${entry.providerId}`,
                  `token=${entry.token}`,
                  `status=${entry.thread.status}`,
                  `output=${JSON.stringify(output)}`,
                  `events=${events
                    .map((event) => `${event.seq}:${event.type}`)
                    .join(",")}`,
                ].join("; "),
              );
            }
            expect(
              (await getThreadEvents(harness.api, entry.thread.id)).every(
                (event) => event.threadId === entry.thread.id,
              ),
            ).toBe(true);
          }
        },
      ));
  },
);
