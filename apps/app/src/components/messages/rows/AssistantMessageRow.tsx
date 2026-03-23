import type { UIAssistantTextMessage } from "@bb/domain";
import { ConversationMarkdown } from "../ConversationMarkdown";

export function AssistantMessageRow({
  message,
}: {
  message: UIAssistantTextMessage;
}) {
  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md p-2 text-sm leading-relaxed">
          <ConversationMarkdown content={message.text} />
        </div>
      </div>
    </div>
  );
}
