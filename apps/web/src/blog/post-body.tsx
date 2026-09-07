import type { ReactNode } from "react";

import { ChangelogInline } from "../landing/changelog-inline";
import { getImageSize } from "./image-sizes";
import { LightboxImage } from "./lightbox";
import type { Post, PostBlock } from "./parse-post";
import { getTweet, type Tweet } from "./tweets";

function Block({ block }: { block: PostBlock }): ReactNode {
  switch (block.kind) {
    case "heading":
      return <h2>{block.text}</h2>;
    case "paragraph":
      return (
        <p>
          <ChangelogInline text={block.text} />
        </p>
      );
    case "list":
      return (
        <ul>
          {block.items.map((item) => (
            <li key={item}>
              <ChangelogInline text={item} />
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote className="post-quote">
          {block.lines.map((line) => (
            <p key={line}>
              <ChangelogInline text={line} />
            </p>
          ))}
        </blockquote>
      );
    case "image":
      return (
        <PostMedia
          src={block.src}
          alt={block.alt}
          caption={block.caption}
          href={block.href}
        />
      );
    case "tweet":
      return <TweetEmbed href={block.href} id={block.id} />;
  }
}

function XMark() {
  return (
    <svg className="tweet-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M14.23 10.18 22.4 1h-1.94l-7.1 8.05L7.7 1H1.2l8.57 12.17L1.2 23h1.94l7.49-8.5L16.3 23h6.5L14.23 10.18Zm-2.65 3.01-.87-1.21L3.84 2.43h2.98l5.58 7.77.87 1.21 7.26 10.11h-2.98l-5.97-8.33Z"
      />
    </svg>
  );
}

function TweetCard({ tweet }: { tweet: Tweet }) {
  return (
    <article className="tweet">
      <a
        className="tweet-head"
        href={tweet.href}
        target="_blank"
        rel="noreferrer"
      >
        <img
          className="tweet-avatar"
          src={tweet.avatarSrc}
          alt=""
          width={40}
          height={40}
        />
        <span className="tweet-who">
          <span className="tweet-name">{tweet.name}</span>
          <span className="tweet-handle">@{tweet.handle}</span>
        </span>
        <XMark />
      </a>
      <p className="tweet-text">{tweet.text}</p>
      {tweet.media?.kind === "video" ? (
        <video
          className="tweet-media"
          controls
          playsInline
          preload="metadata"
          poster={tweet.media.poster}
          width={tweet.media.width}
          height={tweet.media.height}
        >
          <source src={tweet.media.src} type="video/mp4" />
        </video>
      ) : tweet.media?.kind === "image" ? (
        <img
          className="tweet-media"
          src={tweet.media.src}
          alt=""
          width={tweet.media.width}
          height={tweet.media.height}
        />
      ) : null}
      <a
        className="tweet-foot"
        href={tweet.href}
        target="_blank"
        rel="noreferrer"
      >
        <time dateTime={tweet.dateIso}>{tweet.date}</time>
      </a>
    </article>
  );
}

function TweetEmbed({ href, id }: { href: string; id: string }) {
  const tweet = getTweet(id);
  if (!tweet) {
    return (
      <p className="tweet-fallback">
        <a
          className="release-link"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          View on X
        </a>
      </p>
    );
  }
  return <TweetCard tweet={tweet} />;
}

function PostMedia({
  src,
  alt,
  caption,
  href,
}: {
  src: string;
  alt: string;
  caption?: string;
  href?: string;
}) {
  const size = getImageSize(src);
  return (
    <figure className="post-figure">
      {href ? (
        <a
          className="post-figure-link"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          <img
            src={src}
            alt={alt}
            loading="lazy"
            width={size?.width}
            height={size?.height}
          />
        </a>
      ) : (
        <LightboxImage src={src} alt={alt} />
      )}
      {caption ? (
        <figcaption>
          <ChangelogInline text={caption} />
        </figcaption>
      ) : null}
    </figure>
  );
}

export function PostHeader({
  src,
  alt,
  lightbox = false,
}: {
  src: string;
  alt: string;
  lightbox?: boolean;
}) {
  const size = getImageSize(src);
  return (
    <figure className="post-header">
      {lightbox ? (
        <LightboxImage src={src} alt={alt} loading="eager" />
      ) : (
        <img src={src} alt={alt} width={size?.width} height={size?.height} />
      )}
    </figure>
  );
}

export function PostLede({ text }: { text: string }) {
  return (
    <p className="lede">
      <ChangelogInline text={text} />
    </p>
  );
}

export function PostBlocks({ post }: { post: Post }) {
  return (
    <>
      {post.blocks.map((block, index) => (
        <Block key={`${block.kind}-${index}`} block={block} />
      ))}
      {post.sourceLabel && post.sourceHref ? (
        <p className="source-note">
          <a
            className="release-link"
            href={post.sourceHref}
            target="_blank"
            rel="noreferrer"
          >
            {post.sourceLabel}
          </a>
          .
        </p>
      ) : null}
    </>
  );
}
