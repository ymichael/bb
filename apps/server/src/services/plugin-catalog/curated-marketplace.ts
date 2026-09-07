import type { MarketplaceManifest } from "./marketplace-manifest.js";
import { CURATED_MARKETPLACE_NAME } from "./marketplace-manifest.js";

export const BUNDLED_CURATED_MARKETPLACE: MarketplaceManifest = {
  schemaVersion: 1,
  name: CURATED_MARKETPLACE_NAME,
  displayName: "BB Community",
  description:
    "Plugins published to the BB registry and reviewed by the BB team.",
  plugins: [
    {
      id: "thread-hover-cards",
      displayName: "Thread Hover Cards",
      description:
        "Preview thread status, the latest agent update, and repository or PR context from the sidebar.",
      icon: "ZoomIn",
      tags: ["interface", "threads", "sidebar"],
      author: { name: "Bersabel Tadesse", github: "brsbl" },
      source: {
        git: {
          url: "https://github.com/brsbl/bb-plugins.git",
          ref: "30f91fd977ba1ce60532af27a68534464fb62516",
        },
      },
    },
    {
      id: "prompt-shaper",
      displayName: "Prompt Improver",
      description:
        "Adds an Improve prompt action to the composer that sends your rough draft to a hidden helper agent, which applies the prompt-shaper skill to rewrite it into a clear, complete prompt and returns it in place for review before you send.",
      icon: "AiContentGenerator01",
      tags: ["agent-interaction", "prompts"],
      author: { name: "Bersabel Tadesse", github: "brsbl" },
      source: {
        git: {
          url: "https://github.com/brsbl/bb-plugins.git",
          ref: "1c6bb2e8ad3551466981e7eb027cc4b1f3428cac",
        },
      },
    },
  ],
};
