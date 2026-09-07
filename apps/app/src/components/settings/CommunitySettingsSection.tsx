import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section.js";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const DISCORD_INVITE_URL = "https://discord.gg/kvBU6tJhcJ";
const GITHUB_REPO_URL = "https://github.com/get-bb/bb";

interface CommunityLinkRowProps {
  description: string;
  href: string;
  icon: IconName;
  label: string;
  openLabel: string;
}

function CommunityLinkRow({
  description,
  href,
  icon,
  label,
  openLabel,
}: CommunityLinkRowProps) {
  return (
    <SettingsWithControl label={label} description={description}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs"
        aria-label={openLabel}
        onClick={() => {
          openUrlInExternalBrowser(href);
        }}
      >
        <Icon name={icon} className="size-3.5 shrink-0" />
        {openLabel}
        <Icon
          name="ExternalLink"
          className="size-3 shrink-0 text-muted-foreground"
        />
      </Button>
    </SettingsWithControl>
  );
}

export function CommunitySettingsSection() {
  return (
    <SettingsSection
      title="Community"
      description="Chat with other bb users and follow development on GitHub."
    >
      <div className="space-y-5">
        <CommunityLinkRow
          label="Discord"
          description="Join the server for support, feedback, and announcements."
          href={DISCORD_INVITE_URL}
          icon="Discord"
          openLabel="Join Discord"
        />
        <CommunityLinkRow
          label="GitHub"
          description="Source code, issues, and releases for the bb project."
          href={GITHUB_REPO_URL}
          icon="Github"
          openLabel="View on GitHub"
        />
      </div>
    </SettingsSection>
  );
}
