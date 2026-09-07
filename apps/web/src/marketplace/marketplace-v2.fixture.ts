import {
  MARKETPLACE_V2_SCHEMA_URL,
  type MarketplaceV2Manifest,
} from "./marketplace-v2.js";
import type { MarketplaceStats } from "./marketplace-stats.js";

export const MARKETPLACE_V2_FIXTURE: MarketplaceV2Manifest = {
  $schema: MARKETPLACE_V2_SCHEMA_URL,
  schemaVersion: 2,
  name: "bb-community",
  displayName: "BB Community",
  description: "Plugins from the bb community.",
  categories: [
    {
      id: "thread-content",
      displayName: "Thread Content",
      description: "Change the content in an open thread.",
    },
    {
      id: "code-and-reviews",
      displayName: "Code & Reviews",
      description: "Work with code and reviews.",
    },
  ],
  collections: [
    {
      id: "new-and-notable",
      displayName: "New & notable",
      pluginIds: ["review-companion", "prompt-library", "missing-plugin"],
    },
  ],
  plugins: [
    {
      id: "prompt-library",
      displayName: "Prompt Library",
      description: "Save and use project prompts.",
      icon: "FileText",
      category: "thread-content",
      screenshots: [
        "https://getbb.app/marketplace/v2/screenshots/prompt-library/overview.png",
      ],
      publishedAt: "2026-07-14T09:30:00Z",
      updatedAt: "2026-08-24T16:45:00+02:00",
      tags: ["prompts", "templates"],
      author: { name: "BB Labs", github: "get-bb" },
      source: {
        npm: {
          package: "@get-bb/plugin-prompt-library",
          range: "^1.2.0",
        },
      },
    },
    {
      id: "review-companion",
      displayName: "Review Companion",
      description: "Keep pull request checks with review context.",
      icon: {
        url: "https://getbb.app/marketplace/v1/icons/review-companion.svg",
      },
      category: "code-and-reviews",
      screenshots: [],
      publishedAt: "2026-08-20T09:30:00Z",
      tags: ["github", "code-review"],
      author: { name: "Acme", github: "acme-tools" },
      source: {
        git: {
          url: "https://github.com/acme/bb-plugins.git",
          subdir: "plugins/review-companion",
          range: ">=1.0.0 <2.0.0",
          tagPrefix: "review-companion/",
        },
      },
    },
    {
      id: "review-notes",
      displayName: "Review Notes",
      description: "Save notes for a code review.",
      icon: "FileText",
      category: "code-and-reviews",
      screenshots: [],
      tags: ["notes"],
      author: { name: "Acme", github: "acme-tools" },
      source: {
        git: {
          url: "https://github.com/acme/bb-plugins.git",
          range: "^1.0.0",
        },
      },
    },
    {
      id: "orphan-tool",
      displayName: "Orphan Tool",
      description: "Show an unknown category fallback.",
      icon: "Puzzle",
      category: "future-tools",
      screenshots: [],
      tags: ["future"],
      author: { name: "Solo", github: "solo" },
      source: {
        npm: { package: "orphan-tool", range: "^1.0.0" },
      },
    },
  ],
};

export const MARKETPLACE_STATS_FIXTURE: MarketplaceStats = {
  schemaVersion: 1,
  generatedAt: "2026-08-25T06:17:00.000Z",
  plugins: {
    "prompt-library": { installs: 1_204 },
    "orphan-tool": { installs: 20 },
  },
};
