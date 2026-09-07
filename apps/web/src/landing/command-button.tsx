import { useState } from "react";

import { copyPlainText } from "../lib/copy-plain-text";

export function CommandButton({
  command,
  label,
  size,
  onCopy,
}: {
  command: string;
  label: string;
  size: "hero" | "compact";
  onCopy: (copied: boolean) => void;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    const copied = await copyPlainText(command);
    onCopy(copied);
    setStatus(copied ? "copied" : "failed");
    setTimeout(() => setStatus("idle"), 1500);
  };
  const classes = ["btn", "btn-ghost", "cmd-btn"];
  classes.push(size === "hero" ? "btn-install" : "cmd-compact");
  if (status === "copied") classes.push("copied");
  return (
    <button
      type="button"
      className={classes.join(" ")}
      onClick={() => void copy()}
      aria-label={label}
    >
      <span className="cmd-dollar">$</span>
      <span className="cmd-text">{command}</span>
      <span className="cmd-copy">Copy</span>
      <span
        className={status === "idle" ? "cmd-toast" : "cmd-toast show"}
        aria-hidden="true"
      >
        {status === "failed" ? "Copy failed" : "Copied to clipboard"}
      </span>
    </button>
  );
}
