import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { initAnalytics } from "../landing/analytics";
import { SiteFooter, SiteNav } from "../landing/site-chrome";
import { unfurlMeta } from "../landing/site";
import interWoff2 from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import landingCss from "../landing/landing.css?url";
import blogCss from "../blog/blog.css?url";

const PAGE_TITLE = "Privacy — bb";
const PAGE_DESCRIPTION =
  "What bb collects, what stays on your own machines, and what bb connect can see.";

const LAST_UPDATED = "August 20, 2026";
const CONTACT_EMAIL = "sawyer@terragonlabs.com";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: PAGE_TITLE },
      { name: "description", content: PAGE_DESCRIPTION },
      ...unfurlMeta(PAGE_TITLE, PAGE_DESCRIPTION, "/privacy"),
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
      { rel: "stylesheet", href: blogCss },
    ],
  }),
  component: PrivacyRoute,
});

function PrivacyRoute() {
  useEffect(() => {
    initAnalytics();
  }, []);

  return (
    <div className="wrap">
      <SiteNav />

      <article className="post article">
        <div className="post-body">
          <time className="date-pill" dateTime="2026-08-20">
            Last updated {LAST_UPDATED}
          </time>
          <h1>Privacy</h1>

          <p className="lede">
            bb runs on your own machines. Your prompts, your code, and your
            files go to the bb server that you run, and from there to the AI
            provider that you choose. They do not come to us.
          </p>

          <p>
            This policy covers three separate things. You can use the first one
            alone.
          </p>
          <ol>
            <li>
              <strong>The bb apps</strong> — the desktop app, the CLI, and the
              iOS app.
            </li>
            <li>
              <strong>bb connect</strong> — the optional relay at{" "}
              <code>getbb.app</code> that lets you reach your own machine from
              somewhere else.
            </li>
            <li>
              <strong>This website</strong> — <code>getbb.app</code>.
            </li>
          </ol>

          <h2>1. The bb apps</h2>

          <p>
            The apps talk to a bb server that you run. We do not operate that
            server and we do not receive its data. This includes your prompts,
            your agent conversations, your source code, your files, your
            terminal output, and your provider API keys.
          </p>

          <p>The iOS app keeps this on the device:</p>
          <ul>
            <li>
              <strong>Server profiles</strong> — the address of each bb server
              you added, and the credential that reaches it. These live in the
              iOS Keychain.
            </li>
            <li>
              <strong>Preferences and drafts</strong> — your theme, your list
              order, and unsent message drafts. These live in the app&rsquo;s
              own storage.
            </li>
          </ul>

          <p>
            The iOS app sends no analytics, no telemetry, and no crash reports
            to us.
          </p>

          <p>
            The app asks for the camera, the microphone, and the photo library
            only when you attach an image or dictate a prompt. That content goes
            to your bb server. It does not go to us.
          </p>

          <h2>2. bb connect</h2>

          <p>
            bb connect is optional. It gives your machine an address such as{" "}
            <code>yourhandle.getbb.app</code>, so the iOS app can reach it from
            a phone network. If you only use bb on your own network, you never
            touch it.
          </p>

          <p>When you sign in to bb connect, we store:</p>
          <ul>
            <li>
              Your GitHub account details: name, email address, GitHub login,
              and avatar URL.
            </li>
            <li>
              The access tokens that keep you signed in to GitHub, and your bb
              sign-in sessions. A session record includes the IP address and the
              browser user agent that created it.
            </li>
            <li>
              Your handle, and a record of each machine and server you enroll:
              its name, its subdomain, and a hash of its credential. We do not
              store the credential itself.
            </li>
            <li>
              Short-lived pairing codes, and an audit log of account actions
              such as enrolling or revoking a machine.
            </li>
          </ul>

          <p>
            <strong>What the relay can see.</strong> Traffic between the app and
            your machine passes through the relay while it is in flight. TLS
            protects it from the network, but the relay terminates that TLS, so
            the relay handles the content. We do not record it and we do not
            store it. The only thing the relay keeps is an edge cache of
            immutable static assets, such as the app&rsquo;s own JavaScript and
            images. Treat the relay as a trusted intermediary rather than as
            end-to-end encryption, and do not use it if your threat model
            forbids that.
          </p>

          <p>
            You can revoke any machine at any time from the connect dashboard.
            Revoking it ends its address immediately.
          </p>

          <h2>3. This website</h2>

          <p>
            The marketing pages use PostHog to measure how people find bb.
            Automatic event capture is off. The pages send page views, the
            referrer and any campaign parameters in the URL, and a small set of
            named events, such as a click on a download link or a copy of the
            install command.
          </p>

          <p>
            If you give us your email address to follow releases, we keep it to
            send you those emails, and nothing else. Every email has an
            unsubscribe link.
          </p>

          <h2>What we do not do</h2>
          <ul>
            <li>We do not sell your data.</li>
            <li>We do not share it with advertisers.</li>
            <li>
              We do not read, store, or train on your prompts, your code, or
              your agent conversations.
            </li>
          </ul>

          <h2>Keeping and deleting data</h2>

          <p>
            We keep your bb connect account data until you delete the account.
            Sign-in sessions and pairing codes expire on their own. Write to us
            at the address below to delete your account, and we will remove your
            account record, your machines, and your handle.
          </p>

          <p>
            Data held by the bb apps is yours. Deleting the iOS app removes its
            profiles, preferences, and drafts from the device.
          </p>

          <h2>Children</h2>

          <p>
            bb is a developer tool. It is not directed at children under 13, and
            we do not knowingly collect their data.
          </p>

          <h2>Changes</h2>

          <p>
            We will update this page when the product changes, and we will move
            the date at the top. bb is open source, so you can also read the
            history of this page in the repository.
          </p>

          <h2>Contact</h2>

          <p>
            Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>{" "}
            with any question about this policy, or open an issue on{" "}
            <a href="https://github.com/get-bb/bb">GitHub</a>.
          </p>
        </div>
      </article>

      <SiteFooter />
    </div>
  );
}
