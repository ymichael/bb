import type { ReactNode } from "react";
import type { SystemExecutionOptionsModelLoadError } from "@bb/server-contract";
import { useUrlAnchorClickHandler } from "@/lib/url-open-routing";

interface ModelLoadErrorMessageProps {
  error: SystemExecutionOptionsModelLoadError;
  providerLabel: string;
  installUrl?: string;
}

interface FormatModelLoadErrorTextArgs {
  error: SystemExecutionOptionsModelLoadError;
  providerLabel: string;
}

export function formatModelLoadErrorText({
  error,
  providerLabel,
}: FormatModelLoadErrorTextArgs): string {
  if (error.code === "provider_unavailable") {
    return `${providerLabel} is unavailable because its provider plugin failed to load.`;
  }

  if (error.code === "timeout") {
    return `Timed out loading models for ${providerLabel}.`;
  }

  if (error.code === "missing_executable") {
    return `Could not load models for ${providerLabel}. Please make sure the ${providerLabel} CLI is installed.`;
  }

  if (error.code === "auth_required") {
    return `Could not load models for ${providerLabel}. Authentication is required.`;
  }

  return `Could not load models for ${providerLabel}.`;
}

export function ModelLoadErrorMessage({
  error,
  providerLabel,
  installUrl,
}: ModelLoadErrorMessageProps): ReactNode {
  const helpUrl = error.code === "missing_executable" ? installUrl : undefined;
  const handleHelpLinkClick = useUrlAnchorClickHandler(helpUrl);

  if (error.code === "missing_executable") {
    if (helpUrl === undefined) {
      return formatModelLoadErrorText({ error, providerLabel });
    }
    return (
      <>
        Could not load models for {providerLabel}. Please make sure the{" "}
        <a
          href={helpUrl}
          target="_blank"
          rel="noreferrer"
          onClick={handleHelpLinkClick}
          className="underline underline-offset-2 hover:text-foreground"
        >
          {providerLabel} CLI
        </a>{" "}
        is installed.
      </>
    );
  }

  if (error.code === "auth_required") {
    return (
      <>
        Could not load models for {providerLabel}. Authentication is required.
      </>
    );
  }

  return formatModelLoadErrorText({ error, providerLabel });
}
