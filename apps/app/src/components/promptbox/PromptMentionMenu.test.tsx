import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PromptMentionSuggestion } from "@bb/core";
import { PromptMentionMenu } from "./PromptMentionMenu";

describe("PromptMentionMenu", () => {
  it("shows manager-aware search hint copy", () => {
    const html = renderToStaticMarkup(
      <PromptMentionMenu
        showQueryHint
        mentionSearchScope="files-and-managers"
        mentionLoading={false}
        mentionError={false}
        mentionSuggestions={[]}
        selectedMentionIndex={0}
        mentionItemRefs={{ current: [] }}
        onApplyMention={vi.fn()}
      />,
    );

    expect(html).toContain("Type to search files and managers");
  });

  it("renders manager suggestions distinctly from regular threads", () => {
    const mentionSuggestions: PromptMentionSuggestion[] = [
      {
        kind: "thread",
        path: "thread:manager-1",
        replacement: "thread:manager-1",
        threadId: "manager-1",
        title: "Release Manager",
        threadType: "manager",
      },
      {
        kind: "thread",
        path: "thread:worker-1",
        replacement: "thread:worker-1",
        threadId: "worker-1",
        title: "Fix flaky test",
        threadType: "standard",
      },
    ];

    const html = renderToStaticMarkup(
      <PromptMentionMenu
        showQueryHint={false}
        mentionSearchScope="files-and-threads"
        mentionLoading={false}
        mentionError={false}
        mentionSuggestions={mentionSuggestions}
        selectedMentionIndex={0}
        mentionItemRefs={{ current: [] }}
        onApplyMention={vi.fn()}
      />,
    );

    expect(html).toContain("Release Manager");
    expect(html).toContain("Manager · manager-1");
    expect(html).toContain("Fix flaky test");
    expect(html).toContain(">Thread</div>");
    expect(html).toContain("lucide-user-round");
    expect(html).toContain("lucide-folder-git-2");
  });
});
