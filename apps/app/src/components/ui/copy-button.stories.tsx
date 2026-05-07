import { CopyButton } from "./copy-button";

export default {
  title: "Primitives/CopyButton",
};

export function States() {
  return (
    <div className="flex max-w-md items-center gap-4 p-6">
      <CopyButton text="thr_123456789" />
      <CopyButton
        text="proj_987654321"
        label="Copy project ID"
        className="size-8 rounded-md border border-border"
        iconClassName="size-4"
      />
      <CopyButton
        text=""
        label="Copy unavailable value"
        className="size-8 rounded-md border border-border opacity-50"
      />
    </div>
  );
}
