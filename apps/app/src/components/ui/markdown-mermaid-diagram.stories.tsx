import { MarkdownMermaidDiagram } from "./markdown-mermaid-diagram.js";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "ui/Markdown mermaid diagram",
};

const FLOWCHART = `flowchart TD
  A[Start] --> B{Has changes?}
  B -->|Yes| C[Commit]
  B -->|No| D[Skip]
  C --> E[Push]
  D --> E`;

const SEQUENCE = `sequenceDiagram
  participant U as User
  participant S as Server
  U->>S: Request
  S-->>U: Response`;

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="flowchart"
        hint="inline diagram; the Maximize control opens the shadow-sm viewer dialog"
      >
        <div className="w-full max-w-[640px]">
          <MarkdownMermaidDiagram preferredTheme="light" source={FLOWCHART} />
        </div>
      </StoryRow>
      <StoryRow label="sequence" hint="a second diagram kind">
        <div className="w-full max-w-[640px]">
          <MarkdownMermaidDiagram preferredTheme="light" source={SEQUENCE} />
        </div>
      </StoryRow>
    </StoryCard>
  );
}
