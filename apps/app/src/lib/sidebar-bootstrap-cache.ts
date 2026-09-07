import {
  sidebarBootstrapResponseSchema,
  type SidebarBootstrapResponse,
} from "@bb/server-contract";
import { createLastKnownCache } from "@/lib/last-known-cache";

const sidebarBootstrapCache = createLastKnownCache({
  prefix: "bb.sidebar-bootstrap",
  version: "1",
  schema: sidebarBootstrapResponseSchema,
});

export const SIDEBAR_BOOTSTRAP_CACHE_KEY = sidebarBootstrapCache.key();

export const MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT = 30;

const SIDEBAR_BOOTSTRAP_WRITE_IDLE_TIMEOUT_MS = 5_000;
const SIDEBAR_BOOTSTRAP_WRITE_FALLBACK_DELAY_MS = 1_000;

type SidebarProject = SidebarBootstrapResponse["projects"][number];

function boundProject(project: SidebarProject): SidebarProject {
  return project.threads.length <= MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT
    ? project
    : {
        ...project,
        threads: project.threads.slice(
          0,
          MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT,
        ),
      };
}

function boundSidebarBootstrapForCache(
  response: SidebarBootstrapResponse,
): SidebarBootstrapResponse {
  return {
    sections: response.sections,
    projects: response.projects.map(boundProject),
    personalProject: boundProject(response.personalProject),
  };
}

let replay: SidebarBootstrapResponse | null | undefined;

export function readCachedSidebarBootstrap(): SidebarBootstrapResponse | null {
  if (replay === undefined) {
    replay = sidebarBootstrapCache.read(SIDEBAR_BOOTSTRAP_CACHE_KEY);
  }
  return replay;
}

let pendingWrite: SidebarBootstrapResponse | null = null;

function flushPendingWrite(): void {
  const value = pendingWrite;
  pendingWrite = null;
  if (value === null) return;
  sidebarBootstrapCache.write(SIDEBAR_BOOTSTRAP_CACHE_KEY, value);
}

export function writeCachedSidebarBootstrap(
  response: SidebarBootstrapResponse,
): void {
  let bounded: SidebarBootstrapResponse;
  try {
    bounded = boundSidebarBootstrapForCache(response);
  } catch {
    return;
  }
  replay = bounded;
  const alreadyScheduled = pendingWrite !== null;
  pendingWrite = bounded;
  if (alreadyScheduled || typeof window === "undefined") return;
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(flushPendingWrite, {
      timeout: SIDEBAR_BOOTSTRAP_WRITE_IDLE_TIMEOUT_MS,
    });
    return;
  }
  window.setTimeout(
    flushPendingWrite,
    SIDEBAR_BOOTSTRAP_WRITE_FALLBACK_DELAY_MS,
  );
}

export function resetSidebarBootstrapCacheForTest(): void {
  replay = undefined;
  pendingWrite = null;
}
