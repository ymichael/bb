import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_STATS_FIXTURE,
  MARKETPLACE_V2_FIXTURE,
} from "./marketplace-v2.fixture.js";
import {
  PublicMarketplaceAuthorPage,
  PublicMarketplaceDetailPage,
  PublicMarketplacePage,
  PublicMarketplaceUnavailablePage,
} from "./public-marketplace.js";

describe("public marketplace route rendering", () => {
  it("renders the marketplace route with document shelves and controls", () => {
    const html = renderToStaticMarkup(
      <PublicMarketplacePage
        manifest={MARKETPLACE_V2_FIXTURE}
        stats={MARKETPLACE_STATS_FIXTURE}
        state={{}}
        onStateChange={() => {}}
      />,
    );
    expect(html).toContain("Make bb yours.");
    expect(html).toContain(
      "Themes, providers, workflows, and tools, installed with one command.",
    );
    expect(html).toContain("New &amp; notable");
    expect(html).toContain("More plugins");
    expect(html).toContain("Featured");
    expect(html).toContain("Popular");
    expect(html).toContain("marketplace-shelf-notable");
    expect(html).toContain("marketplace-new-chip");
    expect(html).toContain("https://github.com/get-bb.png?size=32");
    expect(html).toContain("https://getbb.app/marketplace/v1/icons");
    expect(html).toContain('<select aria-label="Category">');
    expect(html).toContain(
      '<option value="" selected="">All categories</option>',
    );
    expect(html).toContain(
      '<option value="thread-content">Thread Content (1)</option>',
    );
    expect(html).toContain(
      '<option value="code-and-reviews">Code &amp; Reviews (2)</option>',
    );
    expect(html).toContain(
      '<option value="uncategorized">More plugins (1)</option>',
    );
    expect(html).not.toContain("marketplace-category-pill");
    expect(html).not.toContain("marketplace-category-filters");
    expect(html).not.toContain("mask-image");
  });

  it("filters the marketplace route to one selected category", () => {
    const html = renderToStaticMarkup(
      <PublicMarketplacePage
        manifest={MARKETPLACE_V2_FIXTURE}
        stats={MARKETPLACE_STATS_FIXTURE}
        state={{ category: "code-and-reviews" }}
        onStateChange={() => {}}
      />,
    );
    expect(html).toContain(
      '<option value="code-and-reviews" selected="">Code &amp; Reviews (2)</option>',
    );
    expect(html).toContain("Filtered plugins");
    expect(html).toContain("2 plugins");
    expect(html).toContain(
      '<span class="marketplace-card-category">Code &amp; Reviews</span>',
    );
    expect(html).not.toContain("marketplace-category-pill");
    expect(html).toContain("Review Companion");
    expect(html).not.toContain("Prompt Library");
    expect(html).not.toContain("New &amp; notable");
  });

  it("renders the detail route with install, source, and image policy", () => {
    const entry = MARKETPLACE_V2_FIXTURE.plugins[0];
    const html = renderToStaticMarkup(
      <PublicMarketplaceDetailPage
        manifest={MARKETPLACE_V2_FIXTURE}
        entry={entry}
        stats={MARKETPLACE_STATS_FIXTURE}
      />,
    );
    expect(html).toContain("Marketplace</a>");
    expect(html).toContain("Thread Content</a>");
    expect(html).toContain(
      'aria-label="Copy bb plugin install prompt-library"',
    );
    expect(html).toContain("cmd-btn cmd-compact");
    expect(html).toContain("bb plugin install prompt-library");
    expect(html).toContain("Get it for macOS");
    expect(html).not.toContain("marketplace-install-command");
    expect(html).not.toContain("Don&#x27;t have bb?");
    expect(html).not.toContain("Runs in bb");
    expect(html).toContain("Listed");
    expect(html).toContain(
      'href="https://www.npmjs.com/package/@get-bb/plugin-prompt-library"',
    );
    expect(html).toContain("View source");
    expect(html).not.toContain("Details");
    expect(html).not.toContain("Install from");
    expect(html).not.toContain("Trust");
    expect(html).not.toContain("<aside");
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).not.toContain("More from BB Labs");
    expect(html).toContain("marketplace-overview-lead");
    expect(html).not.toContain("marketplace-overview-rule");
    expect(html.split(entry.description)).toHaveLength(2);
    expect(html).not.toContain("Version");
    expect(html).not.toContain("Updated");
  });

  it("renders the overview text through the markdown allowlist", () => {
    const entry = {
      ...MARKETPLACE_V2_FIXTURE.plugins[1],
      overview: [
        "## What you get",
        "",
        "Each check stays beside its review. <b>Inline</b> html goes away.",
        "",
        "<script>window.pwned = true</script>",
        "",
        "![logo](https://example.com/logo.png)",
        "",
        "- One [docs page](https://example.com/docs)",
        "- One [plain page](http://example.com)",
        "",
      ].join("\n"),
    };
    const html = renderToStaticMarkup(
      <PublicMarketplaceDetailPage
        manifest={MARKETPLACE_V2_FIXTURE}
        entry={entry}
        stats={MARKETPLACE_STATS_FIXTURE}
      />,
    );
    expect(html).toContain("marketplace-overview-lead");
    const overview = html.slice(
      html.indexOf('class="marketplace-overview"'),
      html.indexOf("More from Acme"),
    );
    expect(overview).toContain("<h3>What you get</h3>");
    expect(overview).toContain("Each check stays beside its review.");
    expect(overview).not.toContain("<script");
    expect(overview).not.toContain("pwned");
    expect(overview).not.toContain("<b>");
    expect(overview).toContain("Inline html goes away.");
    expect(overview).not.toContain("<img");
    expect(overview).toContain(
      'href="https://example.com/docs" target="_blank" rel="noopener noreferrer"',
    );
    expect(overview).not.toContain('href="http://example.com"');
    expect(overview).toContain("plain page");
  });

  it("renders author and category recommendations on a detail route", () => {
    const entry = MARKETPLACE_V2_FIXTURE.plugins[1];
    if (entry === undefined) {
      throw new Error("The fixture needs a second plugin");
    }
    const html = renderToStaticMarkup(
      <PublicMarketplaceDetailPage
        manifest={MARKETPLACE_V2_FIXTURE}
        entry={entry}
        stats={MARKETPLACE_STATS_FIXTURE}
      />,
    );
    expect(html).toContain("More from Acme");
    expect(html).toContain("Review Notes");
    expect(html).toContain("More in Code &amp; Reviews");
    expect(html).toContain('href="https://github.com/acme/bb-plugins"');
    expect(html.indexOf("More from Acme")).toBeLessThan(
      html.indexOf("More in Code &amp; Reviews"),
    );
    expect(html).not.toContain("marketplace-screenshots");
    expect(html).not.toContain("marketplace-overview-rule");
  });

  it("renders the category shelf alone when the author has no other plugins", () => {
    const source = MARKETPLACE_V2_FIXTURE.plugins[1];
    if (source === undefined) {
      throw new Error("The fixture needs a second plugin");
    }
    const entry = {
      ...source,
      id: "solo-review",
      displayName: "Solo Review",
      author: { name: "Solo Reviewer", github: "solo-reviewer" },
    };
    const html = renderToStaticMarkup(
      <PublicMarketplaceDetailPage
        manifest={{
          ...MARKETPLACE_V2_FIXTURE,
          plugins: [...MARKETPLACE_V2_FIXTURE.plugins, entry],
        }}
        entry={entry}
        stats={MARKETPLACE_STATS_FIXTURE}
      />,
    );
    expect(html).toContain("marketplace-detail-body");
    expect(html).toContain("More in Code &amp; Reviews");
    expect(html).not.toContain("marketplace-author-teasers");
    expect(html).not.toContain("More from Solo Reviewer");
  });

  it("renders the author route with the same toolbar", () => {
    const entries = MARKETPLACE_V2_FIXTURE.plugins.filter(
      (entry) => entry.author.github === "acme-tools",
    );
    const html = renderToStaticMarkup(
      <PublicMarketplaceAuthorPage
        manifest={MARKETPLACE_V2_FIXTURE}
        entries={entries}
        stats={MARKETPLACE_STATS_FIXTURE}
        state={{}}
        onStateChange={() => {}}
      />,
    );
    expect(html).toContain("Acme");
    expect(html).toContain("2 plugins in the Marketplace");
    expect(html).toContain("https://github.com/acme-tools.png?size=64");
    expect(html).toContain("https://github.com/acme-tools");
    expect(html).toContain("Search plugins");
    expect(html).toContain("Featured");
    expect(html).toContain("Popular");
    expect(html).toContain("Review Companion");
  });

  it("renders the unavailable route", () => {
    const html = renderToStaticMarkup(<PublicMarketplaceUnavailablePage />);
    expect(html).toContain("The Marketplace is not available");
    expect(html).toContain("Try again later");
  });
});
