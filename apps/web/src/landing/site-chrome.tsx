import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { DASHBOARD_PATH } from "../lib/connect-return-to";
import { DiscordLink, DownloadLink, GitHubLink, XLink } from "./cta";

type SiteNavPage = "blog" | "changelog" | "plugins";

export function SiteNav({ current }: { current?: SiteNavPage }) {
  return (
    <nav className="nav">
      {}
      <a className="logo" href="/" aria-label="bb">
        <span className="bb-mark logo-mark" />
      </a>
      <div className="nav-links">
        <a
          className={current === "plugins" ? "nav-current" : undefined}
          href="/marketplace"
        >
          Plugins
        </a>
        <a
          className={current === "blog" ? "nav-current" : undefined}
          href="/blog"
        >
          Blog
        </a>
        <a
          className={current === "changelog" ? "nav-current" : undefined}
          href="/changelog"
        >
          Changelog
        </a>
        <a href={DASHBOARD_PATH}>Sign in</a>
        <GitHubLink
          placement="nav"
          className="nav-icon-button"
          aria-label="GitHub"
        >
          <HugeiconsIcon icon={GithubIcon} />
        </GitHubLink>
        <DownloadLink placement="nav" className="btn btn-primary btn-sm">
          Download for macOS
        </DownloadLink>
      </div>
    </nav>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <span>bb is free and open source (MIT)</span>
      <span>
        <a href="/blog">Blog</a>
        {" · "}
        <a href="/changelog">Changelog</a>
        {" · "}
        <a href="/privacy">Privacy</a>
        {" · "}
        <GitHubLink placement="footer">GitHub</GitHubLink>
        {" · "}
        <XLink placement="footer">X</XLink>
        {" · "}
        <DiscordLink placement="footer">Discord</DiscordLink>
        {" · "}
        <DownloadLink placement="footer">Download</DownloadLink>
      </span>
    </footer>
  );
}
