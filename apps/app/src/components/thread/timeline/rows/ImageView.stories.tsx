import type { TimelineRow } from "@bb/server-contract";
import {
  ThreadTimelineRows,
  type ThreadTimelineRowsProps,
} from "@/components/thread/timeline";
import { imageViewRow } from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Image View",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const THREAD_ID = "thr_image_view";
const TURN_ID = "019e88bb-c6df-75f0-9b3a-f9e7722595c8";
const STARTED_AT = 1780410615740;
const TRANSPARENT_IMAGE_PATH =
  "/tmp/sightglass-quote-merge-check/transparent-overlay.png";
const SAMPLE_IMAGE_URL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="760" viewBox="0 0 1280 760">
  <rect width="1280" height="760" fill="#f8fafc"/>
  <rect x="0" y="0" width="1280" height="62" fill="#111827"/>
  <text x="32" y="40" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700" fill="#f9fafb">Sightglass Dashboard</text>
  <rect x="34" y="104" width="282" height="136" rx="8" fill="#ffffff" stroke="#d1d5db"/>
  <rect x="348" y="104" width="282" height="136" rx="8" fill="#ffffff" stroke="#d1d5db"/>
  <rect x="662" y="104" width="282" height="136" rx="8" fill="#ffffff" stroke="#d1d5db"/>
  <rect x="976" y="104" width="246" height="136" rx="8" fill="#ffffff" stroke="#d1d5db"/>
  <text x="58" y="146" font-family="Inter, Arial, sans-serif" font-size="16" fill="#6b7280">Revenue</text>
  <text x="58" y="196" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="700" fill="#111827">$42.8k</text>
  <text x="372" y="146" font-family="Inter, Arial, sans-serif" font-size="16" fill="#6b7280">Quotes</text>
  <text x="372" y="196" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="700" fill="#111827">186</text>
  <text x="686" y="146" font-family="Inter, Arial, sans-serif" font-size="16" fill="#6b7280">Merge Risk</text>
  <text x="686" y="196" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="700" fill="#b45309">Low</text>
  <text x="1000" y="146" font-family="Inter, Arial, sans-serif" font-size="16" fill="#6b7280">Latency</text>
  <text x="1000" y="196" font-family="Inter, Arial, sans-serif" font-size="42" font-weight="700" fill="#047857">124ms</text>
  <rect x="34" y="284" width="744" height="414" rx="8" fill="#ffffff" stroke="#d1d5db"/>
  <polyline points="80,636 160,592 240,604 320,520 400,536 480,452 560,472 640,384 720,412" fill="none" stroke="#2563eb" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="818" y="284" width="404" height="414" rx="8" fill="#ffffff" stroke="#d1d5db"/>
  <rect x="866" y="350" width="280" height="20" rx="4" fill="#d1d5db"/>
  <rect x="866" y="410" width="224" height="20" rx="4" fill="#d1d5db"/>
  <rect x="866" y="470" width="316" height="20" rx="4" fill="#d1d5db"/>
  <rect x="866" y="530" width="250" height="20" rx="4" fill="#d1d5db"/>
  <rect x="866" y="590" width="296" height="20" rx="4" fill="#d1d5db"/>
</svg>`);
const TRANSPARENT_IMAGE_URL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M86 258 C150 108, 260 120, 326 214 S492 270, 554 96" stroke="#2563eb" stroke-width="22" opacity="0.72"/>
    <path d="M102 104 L254 104 L254 230 L102 230 Z" stroke="#0f172a" stroke-width="10" opacity="0.78"/>
    <path d="M386 94 L536 178 L386 266 Z" stroke="#059669" stroke-width="12" opacity="0.74"/>
  </g>
  <circle cx="254" cy="230" r="58" fill="#f59e0b" opacity="0.66"/>
  <circle cx="390" cy="126" r="40" fill="#dc2626" opacity="0.62"/>
</svg>`);

const resolveStoryImageViewSrc: NonNullable<
  ThreadTimelineRowsProps["resolveImageViewSrc"]
> = ({ path }) =>
  path === TRANSPARENT_IMAGE_PATH ? TRANSPARENT_IMAGE_URL : SAMPLE_IMAGE_URL;

const baseProps = {
  resolveImageViewSrc: resolveStoryImageViewSrc,
  threadId: THREAD_ID,
  threadRuntimeDisplayStatus: "idle" as const,
  workspaceRootPath: undefined,
};

const completedImageView: TimelineRow = imageViewRow({
  id: "thr_image_view:image-view:call_K2JwaDpg7y69AmcFsZyu3jQi",
  threadId: THREAD_ID,
  turnId: TURN_ID,
  sourceSeqStart: 42,
  sourceSeqEnd: 43,
  startedAt: STARTED_AT,
  createdAt: STARTED_AT + 180,
  status: "completed",
  callId: "call_K2JwaDpg7y69AmcFsZyu3jQi",
  path: "/tmp/sightglass-quote-merge-check/dashboard-main.png",
  durationMs: STARTED_AT + 180 - STARTED_AT,
});

const runningImageView: TimelineRow = {
  ...completedImageView,
  id: "thr_image_view:image-view:call_running",
  sourceSeqStart: 44,
  sourceSeqEnd: 44,
  startedAt: Date.now(),
  createdAt: Date.now(),
  status: "pending",
  callId: "call_running",
  completedAt: null,
};

const interruptedImageView: TimelineRow = {
  ...completedImageView,
  id: "thr_image_view:image-view:call_interrupted",
  sourceSeqStart: 45,
  sourceSeqEnd: 45,
  startedAt: STARTED_AT,
  createdAt: STARTED_AT + 950,
  status: "interrupted",
  callId: "call_interrupted",
  completedAt: STARTED_AT + 950,
};

const longPathImageView: TimelineRow = {
  ...completedImageView,
  id: "thr_image_view:image-view:call_long_path",
  sourceSeqStart: 46,
  sourceSeqEnd: 47,
  callId: "call_long_path",
  path: "/tmp/sightglass-quote-merge-check/reports/desktop/homepage/regression/after/very-long-dashboard-main-responsive-state.png",
};

const secondCompletedImageView: TimelineRow = {
  ...completedImageView,
  id: "thr_image_view:image-view:call_visual_diff",
  sourceSeqStart: 48,
  sourceSeqEnd: 49,
  callId: "call_visual_diff",
  path: "/tmp/sightglass-quote-merge-check/dashboard-detail.png",
};

const transparentImageView: TimelineRow = {
  ...completedImageView,
  id: "thr_image_view:image-view:call_transparent",
  sourceSeqStart: 50,
  sourceSeqEnd: 51,
  callId: "call_transparent",
  path: TRANSPARENT_IMAGE_PATH,
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="collapsed — completed"
        hint="production-default — header only, click to expand the viewed image"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[completedImageView]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="expanded — preview"
        hint="expanded body renders the host-file image content"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([completedImageView.id])}
            timelineRows={[completedImageView]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="expanded — transparent background"
        hint="transparent pixels reveal the timeline preview surface"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([transparentImageView.id])}
            timelineRows={[transparentImageView]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — running"
        hint="status=pending, completedAt null"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[runningImageView]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — interrupted"
        hint="status=interrupted, agent cancelled while viewing"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[interruptedImageView]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — long path"
        hint="visible title uses the basename, tooltip/plain title keeps the full path"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[longPathImageView]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="bundle — multiple image views"
        hint="same-concept image-view rows bundle together in an open step"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[completedImageView, secondCompletedImageView]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
