import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { isSideChatShapedThread } from "../shared/side-chat";

interface DeliverCommentInput {
  taskId: string;
  commentId: string;
  body: string;
  authorName: string;
}

type CommentDeliveryOutcome =
  | { threadId: string; status: "delivered" }
  | { threadId: string | null; status: "skipped"; reason: string }
  | { threadId: string; status: "failed"; reason: string };

interface CommentDeliveryResult {
  notifiedCount: number;
  outcomes: CommentDeliveryOutcome[];
}

function steerPrompt(
  taskKey: string,
  authorName: string,
  body: string,
): string {
  return (
    `New comment on task ${taskKey} from ${authorName}: ${body}\n\n` +
    "Treat this as updated context for your work on this task; " +
    `reply via bb tasks comment ${taskKey} when relevant.`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function deliverCommentToLatestAgent(
  bb: BbPluginApi,
  store: TasksStore,
  input: DeliverCommentInput,
): Promise<CommentDeliveryResult> {
  const task = store.getTask(input.taskId);
  if (!task) throw new Error(`Task not found: ${input.taskId}`);

  const latestReply = store.getLatestAgentComment(
    input.taskId,
    input.commentId,
  );
  if (!latestReply) return { notifiedCount: 0, outcomes: [] };
  if (latestReply.threadId === null) {
    return {
      notifiedCount: 0,
      outcomes: [
        {
          threadId: null,
          status: "skipped",
          reason: "latest agent reply has no thread",
        },
      ],
    };
  }

  const threadId = latestReply.threadId;
  const prompt = steerPrompt(task.key, input.authorName, input.body);
  let outcome: CommentDeliveryOutcome;
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    if (isSideChatShapedThread(thread)) {
      outcome = {
        threadId,
        status: "skipped",
        reason: "latest agent reply belongs to a side chat",
      };
    } else {
      await bb.sdk.threads.send({
        threadId,
        input: [{ type: "text", text: prompt, mentions: [] }],
        mode: "steer-if-active",
      });
      outcome = { threadId, status: "delivered" };
    }
  } catch (error) {
    const reason = errorMessage(error);
    bb.log.warn(
      `failed to deliver comment ${input.commentId} to thread ${threadId}: ${reason}`,
    );
    outcome = { threadId, status: "failed", reason };
  }

  return {
    notifiedCount: outcome.status === "delivered" ? 1 : 0,
    outcomes: [outcome],
  };
}
