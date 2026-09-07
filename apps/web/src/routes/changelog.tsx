import { Loading03Icon, Mail01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect } from "react";
import type { ReactNode } from "react";

import changelogMd from "../../../../CHANGELOG.md?raw";
import { RELEASE_META } from "../../../../changelog-metadata";
import { initAnalytics } from "../landing/analytics";
import type { Release, ReleaseBlock } from "../landing/changelog";
import { parseChangelog } from "../landing/changelog";
import { ChangelogInline } from "../landing/changelog-inline";
import {
  EmailSignup,
  focusSubscribeEmail,
  SUBSCRIBE_EMAIL_ID,
} from "../landing/cta";
import { SiteFooter, SiteNav } from "../landing/site-chrome";
import { unfurlMeta } from "../landing/site";
import interWoff2 from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import landingCss from "../landing/landing.css?url";
import changelogCss from "../landing/changelog.css?url";

const PAGE_TITLE = "Changelog — bb";
const PAGE_DESCRIPTION =
  "New features, improvements, and fixes in every bb release.";

export const Route = createFileRoute("/changelog")({
  head: () => ({
    meta: [
      { title: PAGE_TITLE },
      { name: "description", content: PAGE_DESCRIPTION },
      ...unfurlMeta(PAGE_TITLE, PAGE_DESCRIPTION, "/changelog"),
    ],
    links: [
      {
        rel: "preload",
        href: interWoff2,
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      { rel: "stylesheet", href: landingCss },
      { rel: "stylesheet", href: changelogCss },
    ],
  }),
  component: ChangelogRoute,
});

function ChangelogRoute() {
  useEffect(() => {
    initAnalytics();
  }, []);
  return <ChangelogPage />;
}

const RELEASES = parseChangelog(changelogMd);

function anchorId(version: string): string {
  return version.replaceAll(".", "-");
}

function ByMachineSidebar() {
  return (
    <div className="feature-media">
      <div className="media-stage">
        <div
          className="sidebar-card"
          role="img"
          aria-label="bb sidebar grouped by machine, with threads running on two computers"
        >
          <div className="side-label">Sawyer&rsquo;s MacBook Air</div>
          <ul className="threads">
            <li>
              <div className="trow">
                <span className="trow-title">Special Case Handling</span>
                <span className="tstatus" aria-hidden>
                  <HugeiconsIcon icon={Loading03Icon} className="trun" />
                </span>
              </div>
            </li>
            <li>
              <div className="trow">
                <span className="trow-title">
                  Desloppify High-Priority Worker
                </span>
              </div>
              <ul className="threads thread-kids">
                <li>
                  <div className="trow trow-kid">
                    <span className="trow-title">
                      First-principles codebase simplification
                    </span>
                  </div>
                </li>
              </ul>
            </li>
          </ul>
          <div className="side-label">Sawyer&rsquo;s MacBook Pro</div>
          <ul className="threads">
            <li>
              <div className="trow active">
                <span className="trow-title">Design Changelog Page</span>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

const RELEASE_MEDIA: Record<string, ReactNode> = {
  "0.0.30": <ByMachineSidebar />,
};

function Blocks({ blocks }: { blocks: ReleaseBlock[] }) {
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === "list" ? (
          <ul key={index}>
            {block.items.map((item) => (
              <li key={item}>
                <ChangelogInline text={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={index}>
            <ChangelogInline text={block.text} />
          </p>
        ),
      )}
    </>
  );
}

function ReleaseEntry({ release }: { release: Release }) {
  const meta = RELEASE_META[release.version];
  const anchor = anchorId(release.version);
  return (
    <article className="release" id={anchor}>
      <div className="release-rail">
        <div className="rail-sticky">
          <a className="version" href={`#${anchor}`}>
            {release.version}
          </a>
          {meta ? <span className="release-date">{meta.date}</span> : null}
        </div>
      </div>
      <div className="release-body">
        <h2>{meta?.headline ?? release.version}</h2>
        {release.lede.map((block, index) =>
          block.kind === "paragraph" ? (
            <p key={index} className="lede">
              <ChangelogInline text={block.text} />
            </p>
          ) : null,
        )}
        {RELEASE_MEDIA[release.version]}
        {release.sections.map((section) => (
          <Fragment key={section.title}>
            <h3>
              {section.title}
              {section.title === "Experiments" ? (
                <span className="h-chip">Beta</span>
              ) : null}
            </h3>
            <Blocks blocks={section.blocks} />
          </Fragment>
        ))}
      </div>
    </article>
  );
}

function ChangelogPage() {
  return (
    <div className="wrap">
      <SiteNav current="changelog" />

      <header className="page-head">
        <h1>Changelog</h1>
        <p className="sub">{PAGE_DESCRIPTION}</p>
        <div className="meta-row">
          <a href={`#${SUBSCRIBE_EMAIL_ID}`} onClick={focusSubscribeEmail}>
            <HugeiconsIcon icon={Mail01Icon} className="ri" />
            Get release notes by email
          </a>
        </div>
      </header>

      {RELEASES.map((release) => (
        <ReleaseEntry key={release.version} release={release} />
      ))}

      <section className="subscribe" id="subscribe">
        <h2 className="subscribe-title">Stay in the loop.</h2>
        <p>Get release notes in your inbox. No spam.</p>
        <EmailSignup placement="footer" />
      </section>

      <SiteFooter />
    </div>
  );
}
