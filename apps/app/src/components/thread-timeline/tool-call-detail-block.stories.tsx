import { ToolCallDetailBlock } from "./index";

export default {
  title: "Thread Timeline/ToolCallDetailBlock",
};

export function ToolCalls() {
  return (
    <div className="flex max-w-4xl flex-col gap-4 bg-background p-6 text-foreground">
      <ToolCallDetailBlock
        toolName="web.run"
        argsText={`{
  "search_query": [
    {
      "q": "OpenAI API documentation responses API"
    }
  ]
}`}
        output="Found 4 results from official documentation."
      />
      <ToolCallDetailBlock
        toolName="functions.exec_command"
        argsText={`{
  "cmd": "git status --short",
  "workdir": "/workspace/bb"
}`}
        output="M apps/app/src/components/thread-timeline/ThreadTimelineRows.tsx"
        streaming
      />
      <ToolCallDetailBlock
        toolName="image_gen.imagegen"
        argsText=""
        output=""
      />
    </div>
  );
}
