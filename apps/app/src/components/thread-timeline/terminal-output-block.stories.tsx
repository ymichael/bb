import { TerminalOutputBlock } from "./index";

export default {
  title: "Thread Timeline/TerminalOutputBlock",
};

export function OutputStates() {
  return (
    <div className="flex max-w-4xl flex-col gap-4 bg-background p-6 text-foreground">
      <TerminalOutputBlock
        commandLine="$ pnpm exec turbo run typecheck --filter=@bb/app"
        metadataLines={["source: exec_command", "cwd: /workspace/bb"]}
        output="Tasks: 1 successful, 1 total\nCached: 0 cached, 1 total\nTime: 4.2s\n"
        exitCode={0}
      />
      <TerminalOutputBlock
        commandLine="$ pnpm exec turbo run test --filter=@bb/app"
        metadataLines={["source: exec_command"]}
        output="FAIL src/components/thread-timeline/render.test.tsx\nExpected row body to be visible.\n"
        exitCode={1}
      />
      <TerminalOutputBlock
        commandLine="$ pnpm --filter @bb/app ladle:build"
        output="Building Ladle stories...\nBundling thread timeline stories...\n"
        exitCode={null}
        streaming
      />
    </div>
  );
}
