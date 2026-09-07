import type { ReactNode } from "react";
import { MessageActionBar } from "@/components/thread/timeline/MessageActionBar";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "thread/timeline/Message Action Bar",
};

const noop = () => undefined;

function HoverRevealStage({ children }: { children: ReactNode }) {
  return (
    <div className="group/message flex items-center gap-2 [&_button]:opacity-100">
      {children}
    </div>
  );
}

export function Overview() {
  return (
    <>
      <StoryCard>
        <StoryRow label="main timeline" hint="Copy + Fork">
          <HoverRevealStage>
            <MessageActionBar
              messageText="An agent message you can fork or reply to."
              alignment="end"
              mobileActionDisplay="inline"
              onFork={noop}
            />
          </HoverRevealStage>
        </StoryRow>
        <StoryRow label="user message" hint="Copy + Add to chat">
          <HoverRevealStage>
            <MessageActionBar
              messageText="A user message you can quote into the composer."
              alignment="end"
              mobileActionDisplay="overflow"
              onAddToChat={noop}
            />
          </HoverRevealStage>
        </StoryRow>
        <StoryRow label="disabled" hint="thread not forkable → greyed">
          <HoverRevealStage>
            <MessageActionBar
              messageText="Fork/Reply greyed when the thread can't fork."
              alignment="end"
              mobileActionDisplay="inline"
              onFork={noop}
              disabled
            />
          </HoverRevealStage>
        </StoryRow>
        <StoryRow
          label="inside a side chat"
          hint="Send to main thread, no fork/reply"
        >
          <HoverRevealStage>
            <MessageActionBar
              messageText="A side-chat reply you can hand back to the main thread."
              alignment="start"
              mobileActionDisplay="inline"
              onSendToMain={noop}
            />
          </HoverRevealStage>
        </StoryRow>
      </StoryCard>
    </>
  );
}
