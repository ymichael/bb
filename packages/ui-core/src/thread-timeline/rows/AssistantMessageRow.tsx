import type { ViewAssistantTextMessage } from "@bb/domain";
import { ConversationMarkdown } from "../ConversationMarkdown.js";
import type { ThreadTimelineLocalFileLinkHandler } from "../types.js";

interface AssistantMessageRowProps {
  message: ViewAssistantTextMessage;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
}

export function AssistantMessageRow({
  message,
  onOpenLocalFileLink,
}: AssistantMessageRowProps) {
  return (
    <div className="group w-full">
      <div className="mr-auto w-full">
        <div className="rounded-md p-2 text-sm leading-relaxed">
          <ConversationMarkdown
            content={message.text}
            onOpenLocalFileLink={onOpenLocalFileLink}
          />
        </div>
      </div>
    </div>
  );
}
