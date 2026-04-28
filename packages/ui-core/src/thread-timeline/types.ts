export type ThreadTimelineTheme = "light" | "dark";

export interface ThreadTimelineRenderOptions {
  initialExpanded?: boolean;
}

export interface ThreadTimelineLocalFileLink {
  lineNumber: number | null;
  path: string;
}

/**
 * Return `true` when the link was handled and anchor navigation should be
 * prevented. Return `false` to leave the link as a normal anchor.
 */
export type ThreadTimelineLocalFileLinkHandler = (
  link: ThreadTimelineLocalFileLink,
) => boolean;

export type UserAttachmentImageSrcResolver = (
  pathOrUrl: string,
  projectId?: string,
) => string;
