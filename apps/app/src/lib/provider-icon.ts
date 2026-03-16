import type { ComponentType } from "react"
import { ClaudeIcon } from "@/components/icons/ClaudeIcon"
import { OpenAiIcon } from "@/components/icons/OpenAiIcon"
import { PiIcon } from "@/components/icons/PiIcon"

interface ProviderIconInfo {
  icon: ComponentType<{ className?: string }>
  ariaLabel: string
}

/**
 * Maps closed_internal provider IDs to their brand icon components.
 * Returns undefined for unknown providers so callers can fall back gracefully.
 */
export function getProviderIconInfo(
  providerId: string,
): ProviderIconInfo | undefined {
  switch (providerId) {
    case "codex":
      return { icon: OpenAiIcon, ariaLabel: "Codex" }
    case "claude-code":
      return { icon: ClaudeIcon, ariaLabel: "Claude Code" }
    case "pi":
      return { icon: PiIcon, ariaLabel: "Pi" }
    default:
      return undefined
  }
}
