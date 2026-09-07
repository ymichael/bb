import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { WorkspaceDiffTarget } from "@bb/domain";
import {
  DIFF_PATCH_MAX_PATHS_PER_REQUEST,
  type DiffPatchEntry,
  type EnvironmentDiffPatchResponse,
} from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { extractErrorMessage } from "@bb/core-ui";
import {
  type PatchQueryIdentity,
  getDiffPatchEvictionGeneration,
  readDiffPatchEntry,
  retainDiffPatchQueries,
  writeDiffPatchEntry,
} from "../cache-owners/environment-diff-patch-cache-owner";
import { environmentDiffTargetKey } from "./query-keys";

const PATCH_REQUEST_DEBOUNCE_MS = 80;

type DiffPatchStatus = "idle" | "loading" | "loaded" | "error";

export interface DiffPatchState {
  status: DiffPatchStatus;
  patch?: string;
  truncated?: boolean;
  error?: string;
}

interface RequestDiffPatchPathsArgs {
  visible: string[];
  overscan: string[];
}

interface UseEnvironmentDiffPatchesArgs {
  target?: WorkspaceDiffTarget;
}

type RequestDiffPatchPaths = (args: RequestDiffPatchPathsArgs) => void;
type GetDiffPatchState = (path: string) => DiffPatchState;
export type RetryDiffPatchPath = (path: string) => void;
export type LoadDiffPatchPath = (path: string) => void;
type SeedDiffPatchEntries = (entries: DiffPatchEntry[]) => void;

interface UseEnvironmentDiffPatchesResult {
  requestPaths: RequestDiffPatchPaths;
  getPatchState: GetDiffPatchState;
  retry: RetryDiffPatchPath;
  loadPath: LoadDiffPatchPath;
  seedInitialPatches: SeedDiffPatchEntries;
}

const IDLE_STATE: DiffPatchState = { status: "idle" };

interface PendingPaths {
  visible: string[];
  overscan: string[];
}

interface InFlightState {
  loading: ReadonlyMap<string, number>;
  errors: ReadonlyMap<string, string>;
}

const EMPTY_IN_FLIGHT: InFlightState = {
  loading: new Map(),
  errors: new Map(),
};

function abortPatchRequests(controllers: Set<AbortController>): void {
  for (const controller of controllers) {
    controller.abort();
  }
  controllers.clear();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function dedupeOrderedPaths(args: PendingPaths): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const path of [...args.visible, ...args.overscan]) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    ordered.push(path);
  }
  return ordered;
}

function chunkPaths(paths: string[]): string[][] {
  const pages: string[][] = [];
  for (
    let index = 0;
    index < paths.length;
    index += DIFF_PATCH_MAX_PATHS_PER_REQUEST
  ) {
    pages.push(paths.slice(index, index + DIFF_PATCH_MAX_PATHS_PER_REQUEST));
  }
  return pages;
}

function patchPageError(
  response: EnvironmentDiffPatchResponse,
): string | undefined {
  switch (response.outcome) {
    case "available":
      return undefined;
    case "not_applicable":
      return response.message;
    case "unavailable":
      return response.failure.message;
    default: {
      const _exhaustive: never = response;
      return _exhaustive;
    }
  }
}

export function useEnvironmentDiffPatches(
  environmentId: string,
  { target }: UseEnvironmentDiffPatchesArgs,
): UseEnvironmentDiffPatchesResult {
  const queryClient = useQueryClient();

  const targetType = target?.type ?? null;
  const targetKey = environmentDiffTargetKey(target);
  const targetIdentity = `${targetType ?? "none"}:${targetKey ?? ""}`;

  const identity = useMemo<PatchQueryIdentity>(
    () => ({ environmentId, targetType, targetKey }),
    [environmentId, targetType, targetKey],
  );

  const [inFlight, setInFlight] = useState<InFlightState>(EMPTY_IN_FLIGHT);

  const pendingPathsRef = useRef<PendingPaths>({ visible: [], overscan: [] });
  const targetIdentityRef = useRef(targetIdentity);
  const inFlightRef = useRef(inFlight);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllersRef = useRef<Set<AbortController>>(new Set());

  useEffect(() => {
    inFlightRef.current = inFlight;
  }, [inFlight]);

  useEffect(() => {
    targetIdentityRef.current = targetIdentity;
    pendingPathsRef.current = { visible: [], overscan: [] };
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    abortPatchRequests(abortControllersRef.current);
    setInFlight(EMPTY_IN_FLIGHT);
  }, [targetIdentity]);

  useEffect(() => {
    const abortControllers = abortControllersRef.current;
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      abortPatchRequests(abortControllers);
    };
  }, []);

  useEffect(() => {
    if (!environmentId) {
      return;
    }
    return retainDiffPatchQueries({ queryClient, environmentId });
  }, [environmentId, queryClient]);

  const fetchPage = useCallback(
    async (paths: string[], generationTarget: string) => {
      if (!environmentId || target === undefined) {
        return;
      }
      const evictionGeneration = getDiffPatchEvictionGeneration(environmentId);
      const controller = new AbortController();
      abortControllersRef.current.add(controller);
      try {
        const response = await sdk.environments.diffPatch({
          environmentId,
          target,
          paths,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        if (targetIdentityRef.current !== generationTarget) {
          return;
        }
        if (
          getDiffPatchEvictionGeneration(environmentId) !== evictionGeneration
        ) {
          setInFlight((previous) =>
            clearLoading(previous, paths, evictionGeneration),
          );
          return;
        }
        if (response.outcome === "available") {
          const returnedPaths = new Set<string>();
          for (const entry of response.patches) {
            writeDiffPatchEntry({ queryClient, identity, entry });
            returnedPaths.add(entry.path);
          }
          setInFlight((previous) =>
            settlePage({
              previous,
              paths,
              loadingGeneration: evictionGeneration,
              returnedPaths,
            }),
          );
        } else {
          setInFlight((previous) =>
            settlePage({
              previous,
              paths,
              loadingGeneration: evictionGeneration,
              error: patchPageError(response),
            }),
          );
        }
      } catch (caught) {
        if (isAbortError(caught) || controller.signal.aborted) {
          return;
        }
        if (targetIdentityRef.current !== generationTarget) {
          return;
        }
        if (
          getDiffPatchEvictionGeneration(environmentId) !== evictionGeneration
        ) {
          setInFlight((previous) =>
            clearLoading(previous, paths, evictionGeneration),
          );
          return;
        }
        const message =
          extractErrorMessage(caught) ?? "Failed to load file diff";
        setInFlight((previous) =>
          settlePage({
            previous,
            paths,
            loadingGeneration: evictionGeneration,
            error: message,
          }),
        );
      } finally {
        abortControllersRef.current.delete(controller);
      }
    },
    [environmentId, target, identity, queryClient],
  );

  const dispatchPending = useCallback(() => {
    debounceTimerRef.current = null;
    if (!environmentId || target === undefined) {
      return;
    }
    if (targetIdentityRef.current !== targetIdentity) {
      return;
    }
    const ordered = dedupeOrderedPaths(pendingPathsRef.current);

    const currentEvictionGeneration =
      getDiffPatchEvictionGeneration(environmentId);
    const toFetch = ordered.filter((path) => {
      if (readDiffPatchEntry({ queryClient, identity, path }) !== undefined) {
        return false;
      }
      if (
        isLoadingForCurrentGeneration(
          inFlightRef.current.loading,
          path,
          currentEvictionGeneration,
        )
      ) {
        return false;
      }
      if (inFlightRef.current.errors.has(path)) {
        return false;
      }
      return true;
    });

    if (toFetch.length === 0) {
      return;
    }

    setInFlight((previous) =>
      markLoading(previous, toFetch, currentEvictionGeneration),
    );

    for (const page of chunkPaths(toFetch)) {
      void fetchPage(page, targetIdentity);
    }
  }, [environmentId, target, targetIdentity, identity, queryClient, fetchPage]);

  const requestPaths = useCallback(
    (args: RequestDiffPatchPathsArgs) => {
      pendingPathsRef.current = {
        visible: args.visible,
        overscan: args.overscan,
      };
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(
        dispatchPending,
        PATCH_REQUEST_DEBOUNCE_MS,
      );
    },
    [dispatchPending],
  );

  const loadPathNow = useCallback(
    (path: string) => {
      const generationTarget = targetIdentityRef.current;
      const loadingGeneration = getDiffPatchEvictionGeneration(environmentId);
      setInFlight((previous) =>
        markLoading(previous, [path], loadingGeneration),
      );
      void fetchPage([path], generationTarget);
    },
    [environmentId, fetchPage],
  );

  const retry = useCallback(
    (path: string) => {
      setInFlight((previous) => clearError(previous, path));
      loadPathNow(path);
    },
    [loadPathNow],
  );

  const loadPath = useCallback(
    (path: string) => {
      if (readDiffPatchEntry({ queryClient, identity, path }) !== undefined) {
        return;
      }
      if (
        isLoadingForCurrentGeneration(
          inFlightRef.current.loading,
          path,
          getDiffPatchEvictionGeneration(environmentId),
        ) ||
        inFlightRef.current.errors.has(path)
      ) {
        return;
      }
      loadPathNow(path);
    },
    [environmentId, queryClient, identity, loadPathNow],
  );

  const getPatchState = useCallback(
    (path: string): DiffPatchState => {
      const cached = readDiffPatchEntry({ queryClient, identity, path });
      if (cached !== undefined) {
        return {
          status: "loaded",
          patch: cached.patch,
          truncated: cached.truncated,
        };
      }
      const error = inFlight.errors.get(path);
      if (error !== undefined) {
        return { status: "error", error };
      }
      if (inFlight.loading.has(path)) {
        return { status: "loading" };
      }
      return IDLE_STATE;
    },
    [queryClient, identity, inFlight],
  );

  const seedInitialPatches = useCallback(
    (entries: DiffPatchEntry[]) => {
      for (const entry of entries) {
        writeDiffPatchEntry({ queryClient, identity, entry });
      }
    },
    [queryClient, identity],
  );

  return { requestPaths, getPatchState, retry, loadPath, seedInitialPatches };
}

function markLoading(
  previous: InFlightState,
  paths: string[],
  loadingGeneration: number,
): InFlightState {
  const loading = new Map(previous.loading);
  const errors = new Map(previous.errors);
  for (const path of paths) {
    loading.set(path, loadingGeneration);
    errors.delete(path);
  }
  return { loading, errors };
}

function isLoadingForCurrentGeneration(
  loading: ReadonlyMap<string, number>,
  path: string,
  currentEvictionGeneration: number,
): boolean {
  const loadingGeneration = loading.get(path);
  return (
    loadingGeneration !== undefined &&
    loadingGeneration >= currentEvictionGeneration
  );
}

const MISSING_PATCH_MESSAGE = "No diff was available for this file.";

interface SettlePageArgs {
  previous: InFlightState;
  paths: string[];
  loadingGeneration: number;
  error?: string;
  returnedPaths?: ReadonlySet<string>;
}

function settlePage({
  previous,
  paths,
  loadingGeneration,
  error,
  returnedPaths,
}: SettlePageArgs): InFlightState {
  const loading = new Map(previous.loading);
  const errors = new Map(previous.errors);
  for (const path of paths) {
    if (loading.get(path) === loadingGeneration) {
      loading.delete(path);
    }
    if (error !== undefined) {
      errors.set(path, error);
    } else if (returnedPaths !== undefined && !returnedPaths.has(path)) {
      errors.set(path, MISSING_PATCH_MESSAGE);
    } else {
      errors.delete(path);
    }
  }
  return { loading, errors };
}

function clearError(previous: InFlightState, path: string): InFlightState {
  if (!previous.errors.has(path)) {
    return previous;
  }
  const errors = new Map(previous.errors);
  errors.delete(path);
  return { loading: previous.loading, errors };
}

function clearLoading(
  previous: InFlightState,
  paths: string[],
  loadingGeneration: number,
): InFlightState {
  if (!paths.some((path) => previous.loading.get(path) === loadingGeneration)) {
    return previous;
  }
  const loading = new Map(previous.loading);
  for (const path of paths) {
    if (loading.get(path) === loadingGeneration) {
      loading.delete(path);
    }
  }
  return { loading, errors: previous.errors };
}
