import { getBuiltInAgentProviderInfo, isAgentProviderId } from "@bb/agent-providers"
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
  const providerInfo = isAgentProviderId(providerId)
    ? getBuiltInAgentProviderInfo(providerId)
    : null
  if (!providerInfo) {
    return undefined
  }

  switch (providerId) {
    case "codex":
      return {
        icon: OpenAiIcon,
        ariaLabel: providerInfo.displayName,
      }
    case "claude-code":
      return {
        icon: ClaudeIcon,
        ariaLabel: providerInfo.displayName,
      }
    case "pi":
      return {
        icon: PiIcon,
        ariaLabel: providerInfo.displayName,
      }
    default:
      return undefined
  }
}
