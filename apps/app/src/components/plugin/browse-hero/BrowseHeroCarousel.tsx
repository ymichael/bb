import type { IconName } from "@bb/shared-ui/icon";
import { PLUGINS_BROWSE_DESCRIPTION } from "@/components/plugin/plugins-collection-copy";
import { CREATE_PLUGIN_PROMPT } from "@bb/client-core";
import {
  ShowcaseHeroCarousel,
  type ShowcaseHeroComposerConfig,
  type ShowcaseHeroCopy,
} from "@/components/showcase-hero/ShowcaseHeroCarousel";
import { BROWSE_ARCHETYPES } from "./browse-hero-archetypes";
import { MINI_APP_SCENES } from "./MiniAppScenes";

const PLUGIN_RAIL: readonly IconName[] = [
  "MessageSquare",
  "Folder",
  "ListTodo",
];

const PLUGIN_HERO_COPY: ShowcaseHeroCopy = {
  ariaLabel: "What you can build with bb plugins",
  headlineLead: "Turn bb into",
  composingNoun: "whatever you need",
  description: PLUGINS_BROWSE_DESCRIPTION,
  tablistLabel: "Plugin examples",
  frameTitlePrefix: "bb — ",
  frameBadge: "Plugin",
};

const PLUGIN_HERO_COMPOSER: ShowcaseHeroComposerConfig = {
  promptPrefix: CREATE_PLUGIN_PROMPT,
  placeholder: "Describe the plugin you want to build…",
  draftKey: "plugins-browse-hero",
};

interface BrowseHeroCarouselProps {
  initialIndex?: number;
  autoplay?: boolean;
  composerDisabled?: boolean;
  openRequest?: React.ComponentProps<
    typeof ShowcaseHeroCarousel
  >["openRequest"];
  onComposingChange?: (composing: boolean) => void;
}

export function BrowseHeroCarousel({
  initialIndex = 0,
  autoplay = true,
  composerDisabled = false,
  openRequest = null,
  onComposingChange,
}: BrowseHeroCarouselProps) {
  return (
    <ShowcaseHeroCarousel
      archetypes={BROWSE_ARCHETYPES}
      scenes={MINI_APP_SCENES}
      copy={PLUGIN_HERO_COPY}
      composer={PLUGIN_HERO_COMPOSER}
      rail={PLUGIN_RAIL}
      initialIndex={initialIndex}
      autoplay={autoplay}
      composerDisabled={composerDisabled}
      openRequest={openRequest}
      onComposingChange={onComposingChange}
    />
  );
}
