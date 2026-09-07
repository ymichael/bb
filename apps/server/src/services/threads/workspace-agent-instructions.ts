import fs from "node:fs";
import { Buffer } from "node:buffer";
import path from "node:path";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps, ServerLogger } from "../../types.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { isFsErrorWithCode } from "../lib/fs-errors.js";

export const DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH = "AGENTS.md";

export const WORKSPACE_AGENT_INSTRUCTIONS_RELATIVE_PATH = path.join(
  ".bb",
  "AGENTS.md",
);

function readAgentInstructionsFile(
  logger: ServerLogger,
  filePath: string,
): string | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && isFsErrorWithCode(error, "ENOENT")) {
      return null;
    }
    logger.warn(
      {
        filePath,
        reason: error instanceof Error ? error.message : String(error),
      },
      "Skipping unreadable agent instructions file",
    );
    return null;
  }

  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readDataDirAgentInstructions(
  logger: ServerLogger,
  dataDir: string,
): string | null {
  return readAgentInstructionsFile(
    logger,
    path.join(dataDir, DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH),
  );
}

export async function readWorkspaceAgentInstructions(
  deps: LoggedWorkSessionDeps,
  args: { hostId: string; workspacePath: string },
): Promise<string | null> {
  const filePath = path.join(
    args.workspacePath,
    WORKSPACE_AGENT_INSTRUCTIONS_RELATIVE_PATH,
  );
  let result;
  try {
    result = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.read_file",
        path: filePath,
        rootPath: args.workspacePath,
      },
    });
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const content =
    result.contentEncoding === "utf8"
      ? result.content
      : Buffer.from(result.content, "base64").toString("utf8");
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}
