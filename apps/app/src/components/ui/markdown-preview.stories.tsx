import vscodeIcon from "@/assets/workspace-open-target-icons/vscode.png";
import { MarkdownPreview } from "./markdown-preview";

export default {
  title: "Primitives/MarkdownPreview",
};

const richMarkdown = `# Thread summary

The implementation touched **UI primitives** and kept the app shell stable.

- Added co-located stories
- Preserved the local provider decorator
- Verified the app with Turbo

| Check | Result |
| --- | --- |
| Ladle build | Passed |
| Typecheck | Passed |

> Story fixtures should stay readable and deterministic.

\`\`\`ts
const command = "pnpm exec turbo run typecheck --filter=@bb/app";
console.log(command);
\`\`\`

[Open App.tsx](/Users/michael/src/bb/apps/app/src/App.tsx:42)

![VS Code target](${vscodeIcon})
`;

export function RichContent() {
  return (
    <div className="max-w-3xl rounded-md border border-border bg-card p-6">
      <MarkdownPreview content={richMarkdown} />
    </div>
  );
}

export function PlainText() {
  return (
    <div className="max-w-xl rounded-md border border-border bg-card p-6">
      <MarkdownPreview content="No markdown syntax in this response." />
    </div>
  );
}
