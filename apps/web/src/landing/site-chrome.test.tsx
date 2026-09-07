import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SiteFooter, SiteNav } from "./site-chrome";

describe("site navigation", () => {
  it("shows the compact link set with an icon-only GitHub button", () => {
    const html = renderToStaticMarkup(<SiteNav current="plugins" />);
    const navLinks = html.slice(html.indexOf('class="nav-links"'));
    const links = [...navLinks.matchAll(/<a [^>]*>/gu)].map(
      (match) => match[0],
    );
    expect(links).toHaveLength(6);
    expect(html).toContain('class="nav-current" href="/marketplace">Plugins');
    expect(html).toContain('href="/blog">Blog');
    expect(html).toContain('href="/changelog">Changelog');
    expect(html.indexOf("Changelog")).toBeLessThan(html.indexOf("Sign in"));
    expect(html).toContain("Sign in");
    expect(html).toContain('aria-label="GitHub"');
    expect(html).toContain("Download for macOS");
    expect(html).not.toContain(">GitHub<");
    expect(html).not.toContain("Theme");
    expect(html).not.toContain("<button");
  });

  it("marks Changelog current on the changelog route", () => {
    const html = renderToStaticMarkup(<SiteNav current="changelog" />);
    expect(html).toContain('class="nav-current" href="/changelog">Changelog');
    expect(html).not.toContain('class="nav-current" href="/marketplace"');
    expect(renderToStaticMarkup(<SiteFooter />)).toContain(
      'href="/changelog">Changelog',
    );
  });
});
