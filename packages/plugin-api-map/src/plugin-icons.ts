import {
  ArrowDataTransferHorizontalIcon,
  ArrowReloadHorizontalIcon,
  BellDotIcon,
  BrainIcon,
  BrowserIcon,
  CheckListIcon,
  Calendar03Icon,
  ChartColumnIcon,
  Clock01Icon,
  Coffee01Icon,
  ComputerIcon,
  DatabaseIcon,
  Edit04Icon,
  File01Icon,
  GithubIcon,
  Layers01Icon,
  LockIcon,
  MessageAdd02Icon,
  MessageQuestionIcon,
  SmartPhone01Icon,
  SourceCodeIcon,
  SparklesIcon,
  TerminalIcon,
  TestTubeIcon,
  WorkflowCircle03Icon,
  Activity03Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

interface FirstPartyPlugin {
  id: string;
  icon: IconSvgElement;
}

const FIRST_PARTY_PLUGINS: Record<string, FirstPartyPlugin> = {
  "Account Pooler [Experimental]": { id: "account-pool", icon: Layers01Icon },
  "Ask User Question": { id: "ask-user-question", icon: MessageQuestionIcon },
  Automations: { id: "automations", icon: Clock01Icon },
  "Custom instructions": { id: "custom-instructions", icon: Edit04Icon },
  Docs: { id: "simple-notes", icon: File01Icon },
  GitHub: { id: "github", icon: GithubIcon },
  "Inline visualizations": { id: "inline-vis", icon: BrowserIcon },
  "Keep Awake": { id: "keep-awake", icon: Coffee01Icon },
  Memory: { id: "memory", icon: BrainIcon },
  "Provider retry": { id: "provider-retry", icon: ArrowReloadHorizontalIcon },
  "Provider usage": { id: "provider-usage", icon: ChartColumnIcon },
  "Push notifications": { id: "push-notifications", icon: BellDotIcon },
  "Remote access": { id: "connect", icon: SmartPhone01Icon },
  Secrets: { id: "secrets", icon: LockIcon },
  "Send later": { id: "scheduled-send", icon: Calendar03Icon },
  "Side chat": { id: "side-chat", icon: MessageAdd02Icon },
  Tasks: { id: "tasks", icon: CheckListIcon },
  Workflows: { id: "workflows", icon: WorkflowCircle03Icon },
  "ACP providers": { id: "provider-acp", icon: SparklesIcon },
  "Claude Code provider": { id: "provider-claude-code", icon: SparklesIcon },
  "Codex provider": { id: "provider-codex", icon: SparklesIcon },
  "Pi provider": { id: "provider-pi", icon: SparklesIcon },
};

export function pluginIcon(displayName: string): IconSvgElement | null {
  return FIRST_PARTY_PLUGINS[displayName]?.icon ?? null;
}

export function firstPartyPluginId(displayName: string): string | null {
  return FIRST_PARTY_PLUGINS[displayName]?.id ?? null;
}

const SURFACE_ICONS: Record<string, IconSvgElement> = {
  cli: TerminalIcon,
  "agent-tools": SparklesIcon,
  background: Clock01Icon,
  wire: ArrowDataTransferHorizontalIcon,
  storage: DatabaseIcon,
  "thread-events": Activity03Icon,
  "host-workers": ComputerIcon,
  "bb-sdk": SourceCodeIcon,
  "host-components": Layers01Icon,
  testing: TestTubeIcon,
};

export function surfaceIcon(surfaceId: string): IconSvgElement | null {
  return SURFACE_ICONS[surfaceId] ?? null;
}
