import { useCallback, useMemo, useState } from "react";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { useDebounceValue } from "usehooks-ts";
import {
  buildSectionMentionSuggestions,
  type SectionMentionCandidate,
} from "./sectionMentionSuggestions";
import { buildPathMentionSuggestions } from "./pathMentionSuggestions";
import { buildPluginMentionSuggestions } from "./pluginMentionSuggestions";
import {
  buildProjectMentionSuggestions,
  type ProjectMentionCandidate,
} from "./projectMentionSuggestions";
import {
  usePluginContributions,
  usePluginMentionSearch,
} from "./queries/plugin-contribution-queries";
import { useSidebarNavigation } from "./queries/sidebar-navigation-query";
import { useThreadMentionCandidates } from "./queries/thread-queries";
import { buildThreadMentionSuggestions } from "./threadMentionSuggestions";
import {
  usePathSuggestions,
  PATH_SUGGESTION_DEBOUNCE_MS,
} from "./usePathSuggestions";
import {
  DEFAULT_PLUGIN_MENTION_TRIGGER,
  PLUGIN_MENTION_TRIGGER_VALUES,
  type OrderedMentionSuggestions,
  type PluginMentionTrigger,
} from "@bb/client-core";
import { buildPromptMentionResults } from "./promptMentionCandidates";

const PROMPT_MENTION_SOURCE_LIMIT = 8;

interface UsePromptMentionsOptions {
  currentThreadId?: string;
  threadStorageThreadId?: string;
  environmentId: string | null;
  hostId?: string | null;
}

interface UsePromptMentionsResult {
  query: string | null;
  triggers: readonly PluginMentionTrigger[];
  setQuery: (
    query: string | null,
    trigger: PluginMentionTrigger | null,
  ) => void;
  results: OrderedMentionSuggestions;
  isLoading: boolean;
  isError: boolean;
}

function buildProjectNamesById(
  sidebarNavigation: SidebarBootstrapResponse | undefined,
): ReadonlyMap<string, string> {
  const projectNamesById = new Map<string, string>();
  if (!sidebarNavigation) {
    return projectNamesById;
  }

  for (const project of sidebarNavigation.projects) {
    projectNamesById.set(project.id, project.name);
  }
  return projectNamesById;
}

function buildProjectMentionCandidates(
  sidebarNavigation: SidebarBootstrapResponse | undefined,
): ProjectMentionCandidate[] {
  if (!sidebarNavigation) {
    return [];
  }

  return [...sidebarNavigation.projects, sidebarNavigation.personalProject].map(
    (project) => ({ id: project.id, name: project.name }),
  );
}

function buildSectionMentionCandidates(
  sidebarNavigation: SidebarBootstrapResponse | undefined,
): SectionMentionCandidate[] {
  return (
    sidebarNavigation?.sections.map((section) => ({
      id: section.id,
      name: section.name,
    })) ?? []
  );
}

function buildPluginMentionTriggers(
  providers: readonly { triggers: readonly PluginMentionTrigger[] }[],
): PluginMentionTrigger[] {
  const enabled = new Set<PluginMentionTrigger>([
    DEFAULT_PLUGIN_MENTION_TRIGGER,
  ]);
  for (const provider of providers) {
    for (const trigger of provider.triggers) {
      enabled.add(trigger);
    }
  }
  return PLUGIN_MENTION_TRIGGER_VALUES.filter((trigger) =>
    enabled.has(trigger),
  );
}

export function usePromptMentions(
  projectId: string | undefined,
  options: UsePromptMentionsOptions,
): UsePromptMentionsResult {
  const [activeMention, setActiveMention] = useState<{
    query: string;
    trigger: PluginMentionTrigger;
  } | null>(null);
  const setQuery = useCallback(
    (query: string | null, trigger: PluginMentionTrigger | null) => {
      if (query === null) {
        setActiveMention(null);
        return;
      }
      setActiveMention({
        query,
        trigger: trigger ?? DEFAULT_PLUGIN_MENTION_TRIGGER,
      });
    },
    [],
  );
  const query = activeMention?.query ?? null;
  const trigger = activeMention?.trigger ?? DEFAULT_PLUGIN_MENTION_TRIGGER;
  const includeBuiltInSources = trigger === DEFAULT_PLUGIN_MENTION_TRIGGER;
  const hasQuery = (query?.trim().length ?? 0) > 0;
  const trimmedQuery = query?.trim() ?? "";

  const pathSearch = usePathSuggestions({
    projectId,
    query: includeBuiltInSources ? query : null,
    limit: PROMPT_MENTION_SOURCE_LIMIT,
    environmentId: options.environmentId,
    hostId: options.hostId,
    currentThreadId: options.threadStorageThreadId,
    includeDirectories: true,
  });
  const projectNamesQuery = useSidebarNavigation({
    enabled: includeBuiltInSources && hasQuery,
  });
  const threadsQuery = useThreadMentionCandidates({
    enabled: includeBuiltInSources && hasQuery,
  });
  const pluginContributions = usePluginContributions();
  const hasMentionProviders =
    pluginContributions.data?.mentionProviders.some((provider) =>
      provider.triggers.includes(trigger),
    ) ?? false;
  const mentionTriggers = useMemo(
    () =>
      buildPluginMentionTriggers(
        pluginContributions.data?.mentionProviders ?? [],
      ),
    [pluginContributions.data?.mentionProviders],
  );
  const [debouncedQuery] = useDebounceValue(
    trimmedQuery,
    PATH_SUGGESTION_DEBOUNCE_MS,
  );
  const pluginSearchMatchesInput = debouncedQuery === trimmedQuery;
  const pluginSearch = usePluginMentionSearch(
    {
      trigger,
      query: debouncedQuery,
      projectId: projectId ?? null,
      threadId: options.currentThreadId ?? null,
    },
    {
      enabled:
        hasMentionProviders &&
        pluginSearchMatchesInput &&
        debouncedQuery.length > 0,
    },
  );
  const projectNamesById = useMemo(
    () => buildProjectNamesById(projectNamesQuery.data),
    [projectNamesQuery.data],
  );
  const projectCandidates = useMemo(
    () => buildProjectMentionCandidates(projectNamesQuery.data),
    [projectNamesQuery.data],
  );
  const sectionCandidates = useMemo(
    () => buildSectionMentionCandidates(projectNamesQuery.data),
    [projectNamesQuery.data],
  );

  const currentThreadId = options.currentThreadId;
  const pathSuggestions = useMemo(
    () =>
      includeBuiltInSources
        ? buildPathMentionSuggestions({
            paths: pathSearch.suggestions,
          })
        : [],
    [includeBuiltInSources, pathSearch.suggestions],
  );
  const threadSuggestions = useMemo(() => {
    if (!includeBuiltInSources) return [];
    return buildThreadMentionSuggestions({
      threads: threadsQuery.data ?? [],
      query: trimmedQuery,
      currentProjectId: projectId,
      currentThreadId,
      projectNamesById,
      limit: PROMPT_MENTION_SOURCE_LIMIT,
    });
  }, [
    currentThreadId,
    includeBuiltInSources,
    projectId,
    projectNamesById,
    threadsQuery.data,
    trimmedQuery,
  ]);
  const projectSuggestions = useMemo(() => {
    if (!includeBuiltInSources) return [];
    return buildProjectMentionSuggestions({
      projects: projectCandidates,
      query: trimmedQuery,
      limit: PROMPT_MENTION_SOURCE_LIMIT,
    });
  }, [includeBuiltInSources, projectCandidates, trimmedQuery]);
  const sectionSuggestions = useMemo(() => {
    if (!includeBuiltInSources) return [];
    return buildSectionMentionSuggestions({
      sections: sectionCandidates,
      query: trimmedQuery,
      limit: PROMPT_MENTION_SOURCE_LIMIT,
    });
  }, [sectionCandidates, includeBuiltInSources, trimmedQuery]);
  const pluginSuggestions = useMemo(
    () =>
      hasMentionProviders && pluginSearchMatchesInput
        ? buildPluginMentionSuggestions(pluginSearch.data ?? [])
        : [],
    [hasMentionProviders, pluginSearch.data, pluginSearchMatchesInput],
  );
  const results = useMemo(
    () =>
      buildPromptMentionResults({
        query: hasQuery ? trimmedQuery : "",
        paths: hasQuery ? pathSuggestions : [],
        threads: hasQuery ? threadSuggestions : [],
        projects: hasQuery ? projectSuggestions : [],
        sections: hasQuery ? sectionSuggestions : [],
        plugins: hasQuery ? pluginSuggestions : [],
      }),
    [
      hasQuery,
      pathSuggestions,
      threadSuggestions,
      projectSuggestions,
      sectionSuggestions,
      pluginSuggestions,
      trimmedQuery,
    ],
  );

  const isLoading =
    hasQuery &&
    results.suggestions.length === 0 &&
    ((includeBuiltInSources &&
      (pathSearch.isDebouncing ||
        pathSearch.isLoading ||
        threadsQuery.isLoading ||
        threadsQuery.isFetching)) ||
      (hasMentionProviders &&
        (!pluginSearchMatchesInput ||
          pluginSearch.isLoading ||
          pluginSearch.isFetching)));
  const isThreadError =
    includeBuiltInSources &&
    hasQuery &&
    threadsQuery.isError &&
    !threadsQuery.isLoading &&
    !threadsQuery.isFetching;
  const isError =
    (includeBuiltInSources && pathSearch.isError) || isThreadError;

  return {
    query,
    triggers: mentionTriggers,
    setQuery,
    results,
    isLoading,
    isError,
  };
}
