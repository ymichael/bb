import type { ThreadQueuedMessage } from "@bb/domain";
import { Button } from "@/components/ui/button.js";
import { Icon } from "@/components/ui/icon.js";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import {
  countQueuedMessageAttachments,
  formatQueuedMessagePreview,
} from "@/views/thread-detail/threadQueuedMessages";

export interface QueuedMessagesListProps {
  queuedMessages: readonly ThreadQueuedMessage[];
  sendDisabled: boolean;
  actionDisabled: boolean;
  processingMessageId: string | null;
  onSendImmediately: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

export function QueuedMessagesList({
  queuedMessages,
  sendDisabled,
  actionDisabled,
  processingMessageId,
  onSendImmediately,
  onEdit,
  onDelete,
}: QueuedMessagesListProps) {
  if (queuedMessages.length === 0) return null;

  return (
    <PromptStackCard ariaLabel="Queued messages" className="overflow-hidden">
      <div className="flex items-center justify-between px-2.5 pb-1 pt-2.5">
        <p className="text-xs text-muted-foreground">
          Queued ({queuedMessages.length})
        </p>
      </div>
      <ul>
        {queuedMessages.map((queuedMessage, index) => {
          const preview = formatQueuedMessagePreview(queuedMessage.content);
          const attachmentCount = countQueuedMessageAttachments(
            queuedMessage.content,
          );
          const isProcessing = processingMessageId === queuedMessage.id;
          return (
            <li key={queuedMessage.id} className="px-2.5 py-0.5">
              <div className="flex items-center gap-1.5">
                <div className="p-0.5 text-muted-foreground">
                  <Icon name="CornerDownRight" className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1 text-xs leading-4">
                    <p
                      className="min-w-0 truncate text-foreground"
                      title={preview}
                    >
                      {preview}
                    </p>
                    {attachmentCount > 0 ? (
                      <>
                        <span className="shrink-0 text-muted-foreground">
                          .
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {attachmentCount === 1
                            ? "1 attachment"
                            : `${attachmentCount} attachments`}
                        </span>
                      </>
                    ) : null}
                    {isProcessing ? (
                      <>
                        <span className="shrink-0 text-muted-foreground">
                          .
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          Sending...
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="ml-1 flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="link"
                    className="h-auto px-0 pr-1 text-xs text-muted-foreground underline"
                    disabled={sendDisabled || isProcessing}
                    onClick={() => onSendImmediately(queuedMessage.id)}
                  >
                    {isProcessing ? "Sending..." : "Send now"}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground"
                    disabled={actionDisabled || isProcessing}
                    onClick={() => onEdit(queuedMessage.id)}
                    aria-label={`Edit queued message ${index + 1}`}
                    title="Edit queued message"
                  >
                    <Icon name="Edit" className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    disabled={actionDisabled || isProcessing}
                    onClick={() => onDelete(queuedMessage.id)}
                    aria-label={`Delete queued message ${index + 1}`}
                    title="Delete queued message"
                  >
                    <Icon name="Trash2" className="size-3.5" />
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </PromptStackCard>
  );
}
