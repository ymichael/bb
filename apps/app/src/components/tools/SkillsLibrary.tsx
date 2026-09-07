import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  keepPreviousData,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { buildSkillEditThreadPrompt } from "@bb/shared-ui/resource-edit-prompt";
import type { EditableSkillScope, SkillSummary } from "@bb/server-contract";
import {
  ResourceListState,
  useResourceRouteLabel,
} from "@bb/shared-ui/resource-list";
import {
  RegistrySkillDetailView,
  RegistrySkillsBrowsePage,
} from "@/components/tools/SkillsBrowse";
import { getToolsOwnedCollectionRoutePath } from "@/components/tools/tools-navigation";
import {
  SkillDetailDialogView,
  SkillsOverview,
  type ProviderRoster,
} from "@/components/tools/SkillsCollection";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { isSkillEditable } from "@/components/tools/skill-taxonomy";
import { CREATE_SKILL_PROMPT } from "@bb/client-core";
import {
  buildRegistrySkillReferencePrompt,
  fetchRegistrySkillDetail,
  fetchRegistrySkillEntries,
  fetchRegistrySkillEntry,
  fetchRegistryRepositoryStars,
  fetchRegistrySkills,
  REGISTRY_PAGE_SIZE,
  registryRepositoryKey,
  resolveInstalledRegistrySkill,
} from "@/lib/skills-registry";
import type { RegistryRanking, RegistrySkill } from "@/lib/skills-registry";
import {
  getRegistrySkillDetailRoutePath,
  getRegistrySkillsRoutePath,
  getRootComposeRoutePath,
  getSkillDetailRoutePath,
  getSkillsRoutePath,
} from "@/lib/route-paths";
import {
  prefetchSkillDetail,
  useDeleteSkill,
  useProjectSkills,
  useSkillContent,
  useSkillFiles,
} from "@/hooks/queries/skills-queries";
import { CreateWithTemplatesButton } from "@/components/create-via-prompt-examples";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";

const EMPTY_SKILLS: readonly SkillSummary[] = [];

function useProviderRoster(): ProviderRoster {
  const providers = useSystemProviders().data;
  return useMemo(
    () => new Map((providers ?? []).map((provider) => [provider.id, provider])),
    [providers],
  );
}
const REGISTRY_LIST_STALE_TIME_MS = 30 * 60_000;

function SkillDetailPage({
  projectId,
  skill,
  onClose,
  onEdit,
}: {
  projectId: string;
  skill: SkillSummary | null;
  onClose: () => void;
  onEdit: (skill: SkillSummary) => void;
}) {
  const providerRoster = useProviderRoster();
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  useEffect(() => {
    setSelectedPath("SKILL.md");
  }, [skill?.id]);
  const filesQuery = useSkillFiles(projectId, skill);
  const contentQuery = useSkillContent(projectId, skill, selectedPath);
  const deleteSkill = useDeleteSkill(projectId);
  const { canOpenPreferredFileTarget, openPathInPreferredFileTarget } =
    useLocalOpenTargets({ enabled: skill !== null });

  const deletableScope: EditableSkillScope | null =
    skill && skill.manageable && isSkillEditable(skill) ? skill.scope : null;
  const editableScope: EditableSkillScope | null =
    skill && isSkillEditable(skill) ? skill.scope : null;

  return (
    <SkillDetailDialogView
      skill={skill}
      providerRoster={providerRoster}
      files={filesQuery.data?.files ?? ["SKILL.md"]}
      selectedPath={selectedPath}
      onSelectPath={setSelectedPath}
      content={contentQuery.data?.content ?? ""}
      isLoadingContent={contentQuery.isLoading}
      isContentError={contentQuery.isError}
      canEdit={editableScope !== null}
      canDelete={deletableScope !== null}
      canOpenInEditor={editableScope !== null && canOpenPreferredFileTarget}
      isDeleting={deleteSkill.isPending}
      onEdit={() => {
        if (skill) onEdit(skill);
      }}
      onRetry={() => {
        void filesQuery.refetch();
        void contentQuery.refetch();
      }}
      onDelete={() => {
        if (!skill || deletableScope === null) return;
        deleteSkill.mutate(
          { skillId: skill.id, environmentId: null },
          { onSuccess: onClose },
        );
      }}
      onOpenInEditor={() => {
        if (!skill) return;
        void openPathInPreferredFileTarget({
          path: skill.filePath,
          lineNumber: null,
        });
      }}
    />
  );
}

export function SkillsLibrary() {
  const providerRoster = useProviderRoster();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { skillId: routeSkillId, registrySkillId: routeRegistrySkillId } =
    useParams<{
      skillId?: string;
      registrySkillId?: string;
    }>();
  const [libraryQuery, setLibraryQuery] = useState("");
  const [registrySearch, setRegistrySearch] = useState("");
  const [registryPage, setRegistryPage] = useState(0);
  const skillsQuery = useProjectSkills(PERSONAL_PROJECT_ID);
  const skills = skillsQuery.data?.skills ?? EMPTY_SKILLS;
  const hasError = skillsQuery.isError && skillsQuery.data === undefined;
  const isLoading =
    skillsQuery.isFetching && skillsQuery.data === undefined && !hasError;
  const isRegistryBrowseRoute =
    location.pathname === getRegistrySkillsRoutePath() ||
    (location.pathname === getSkillsRoutePath() &&
      new URLSearchParams(location.search).get("view") !== "library");
  const registryRequestPage =
    isRegistryBrowseRoute || routeRegistrySkillId !== undefined
      ? registryPage
      : 0;
  const registryQuery = useQuery({
    queryKey: ["skills-registry", registrySearch.trim(), registryRequestPage],
    queryFn: ({ signal }) =>
      fetchRegistrySkills({
        query: registrySearch,
        page: registryRequestPage,
        perPage: REGISTRY_PAGE_SIZE,
        signal,
      }),
    enabled: isRegistryBrowseRoute,
    refetchOnWindowFocus: false,
    staleTime: REGISTRY_LIST_STALE_TIME_MS,
  });
  const trimmedRegistrySearch = registrySearch.trim();
  const [loadedRegistry, setLoadedRegistry] = useState<{
    ranking: RegistryRanking;
    search: string;
    skills: RegistrySkill[];
    hasMore: boolean;
  }>({
    ranking: "trending",
    search: trimmedRegistrySearch,
    skills: [],
    hasMore: false,
  });
  useEffect(() => {
    const data = registryQuery.data;
    if (data === undefined) return;
    setLoadedRegistry((current) => {
      const matches =
        current.ranking === data.ranking &&
        current.search === trimmedRegistrySearch;
      const base = matches ? current.skills : [];
      const seen = new Set(base.map((skill) => skill.id));
      const fresh = data.skills.filter((skill) => !seen.has(skill.id));
      return {
        ranking: data.ranking,
        search: trimmedRegistrySearch,
        skills: fresh.length === 0 && matches ? base : [...base, ...fresh],
        hasMore: data.pagination.hasMore,
      };
    });
  }, [registryQuery.data, trimmedRegistrySearch]);
  const loadedRegistrySkills = useMemo(
    () =>
      loadedRegistry.search === trimmedRegistrySearch
        ? loadedRegistry.skills
        : [],
    [loadedRegistry, trimmedRegistrySearch],
  );
  const registryRepositorySources = useMemo(() => {
    const sources = new Map<string, string>();
    for (const skill of loadedRegistrySkills) {
      if (skill.stars === null) {
        const repositoryKey = registryRepositoryKey(skill.source);
        if (!sources.has(repositoryKey)) {
          sources.set(repositoryKey, skill.source);
        }
      }
    }
    return [...sources.entries()].map(([repositoryKey, source]) => ({
      repositoryKey,
      source,
    }));
  }, [loadedRegistrySkills]);
  const registryRepositoryStars = useQueries({
    queries: registryRepositorySources.map(({ repositoryKey, source }) => ({
      queryKey: ["skills-registry-repository-stars", repositoryKey],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchRegistryRepositoryStars(source, signal),
      enabled: isRegistryBrowseRoute,
      staleTime: 6 * 60 * 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    })),
    combine: (results) => ({
      values: new Map(
        registryRepositorySources.flatMap(({ repositoryKey }, index) => {
          const value = results[index]?.data;
          return value === undefined ? [] : ([[repositoryKey, value]] as const);
        }),
      ),
      pendingRepositoryKeys: new Set(
        registryRepositorySources.flatMap(({ repositoryKey }, index) =>
          results[index]?.isPending ? [repositoryKey] : [],
        ),
      ),
    }),
  });
  const registryRanking = loadedRegistry.ranking;
  const registryDescriptionSkillIds = useMemo(
    () =>
      loadedRegistrySkills
        .filter(
          (skill) => skill.summary === null || registryRanking === "trending",
        )
        .map((skill) => skill.id)
        .sort(),
    [loadedRegistrySkills, registryRanking],
  );
  const registryEntriesQuery = useQuery({
    queryKey: ["skills-registry-entries", registryDescriptionSkillIds],
    queryFn: ({ signal }) =>
      fetchRegistrySkillEntries(registryDescriptionSkillIds, signal),
    enabled: isRegistryBrowseRoute && registryDescriptionSkillIds.length > 0,
    staleTime: 30 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  const registryDescriptions = useMemo(() => {
    const values = new Map(
      (registryEntriesQuery.data ?? []).map(
        (entry) => [entry.id, entry] as const,
      ),
    );
    return {
      values,
      pendingSkillIds: new Set(
        registryEntriesQuery.isFetching
          ? registryDescriptionSkillIds.filter((id) => !values.has(id))
          : [],
      ),
    };
  }, [
    registryEntriesQuery.data,
    registryEntriesQuery.isFetching,
    registryDescriptionSkillIds,
  ]);
  const registrySkills = useMemo(
    () =>
      loadedRegistrySkills.map((skill) => {
        const entry = registryDescriptions.values.get(skill.id);
        const describedSkill =
          entry === undefined
            ? skill
            : {
                ...skill,
                ...(registryRanking === "trending"
                  ? { installs: entry.installs }
                  : {}),
                topic: entry.topic,
                summary: entry.summary,
              };
        if (describedSkill.stars !== null) return describedSkill;
        const stars = registryRepositoryStars.values.get(
          registryRepositoryKey(describedSkill.source),
        );
        return stars === undefined
          ? describedSkill
          : { ...describedSkill, stars };
      }),
    [
      loadedRegistrySkills,
      registryDescriptions.values,
      registryRepositoryStars.values,
      registryRanking,
    ],
  );
  const unknownInstallSkillIds = useMemo(
    () =>
      new Set(
        registryRanking === "trending"
          ? loadedRegistrySkills.flatMap((skill) =>
              registryDescriptions.values.has(skill.id) ? [] : [skill.id],
            )
          : [],
      ),
    [registryRanking, loadedRegistrySkills, registryDescriptions.values],
  );
  const pendingRegistrySkillIds = useMemo(
    () =>
      new Set(
        loadedRegistrySkills.flatMap((skill) =>
          registryDescriptions.pendingSkillIds.has(skill.id) ||
          registryRepositoryStars.pendingRepositoryKeys.has(
            registryRepositoryKey(skill.source),
          )
            ? [skill.id]
            : [],
        ),
      ),
    [
      registryDescriptions.pendingSkillIds,
      loadedRegistrySkills,
      registryRepositoryStars.pendingRepositoryKeys,
    ],
  );
  const selectedSkill = useMemo(() => {
    if (routeSkillId === undefined) return null;
    return skills.find((skill) => skill.id === routeSkillId) ?? null;
  }, [routeSkillId, skills]);
  const registrySkillOnPage = useMemo(() => {
    if (routeRegistrySkillId === undefined) {
      return null;
    }
    return (
      registrySkills.find(
        (skill) =>
          skill.id === routeRegistrySkillId ||
          skill.skillId === routeRegistrySkillId,
      ) ?? null
    );
  }, [registrySkills, routeRegistrySkillId]);
  const registryEntryQuery = useQuery({
    queryKey: ["skills-registry-entry", routeRegistrySkillId ?? "none"],
    queryFn: ({ signal }) =>
      fetchRegistrySkillEntry(routeRegistrySkillId!, signal),
    enabled: routeRegistrySkillId !== undefined && registrySkillOnPage === null,
    staleTime: 5 * 60_000,
  });
  const selectedRegistrySkill =
    registrySkillOnPage ?? registryEntryQuery.data ?? null;
  useResourceRouteLabel(
    selectedSkill?.name ?? selectedRegistrySkill?.name ?? null,
  );
  const registryDetailQuery = useQuery({
    queryKey: ["skills-registry-detail", selectedRegistrySkill?.id ?? "none"],
    queryFn: ({ signal }) =>
      fetchRegistrySkillDetail({
        source: selectedRegistrySkill!.source,
        skillId: selectedRegistrySkill!.skillId,
        signal,
      }),
    enabled: selectedRegistrySkill !== null,
    staleTime: 5 * 60_000,
  });
  const findLocalRegistrySkill = useCallback(
    (skill: RegistrySkill): SkillSummary | null =>
      resolveInstalledRegistrySkill(skill, skills),
    [skills],
  );
  const openSkill = useCallback(
    (skill: SkillSummary) => {
      navigate(
        getSkillDetailRoutePath({
          skillId: skill.id,
        }),
      );
    },
    [navigate],
  );
  const editSkillViaThread = useCallback(
    (skill: SkillSummary) => {
      navigate(getRootComposeRoutePath(), {
        state: {
          focusPrompt: true,
          initialPrompt: buildSkillEditThreadPrompt({
            id: skill.id,
            name: skill.name,
            path: skill.filePath,
          }),
          replaceInitialPrompt: true,
        },
      });
    },
    [navigate],
  );
  const openRegistrySkill = useCallback(
    (skill: RegistrySkill) => {
      const localSkill = findLocalRegistrySkill(skill);
      if (localSkill !== null) {
        navigate(
          getSkillDetailRoutePath({
            skillId: localSkill.id,
          }),
        );
        return;
      }
      if (!isRegistryBrowseRoute) setRegistryPage(0);
      navigate(getRegistrySkillDetailRoutePath({ registrySkillId: skill.id }));
    },
    [findLocalRegistrySkill, isRegistryBrowseRoute, navigate],
  );
  const handleRegistryQueryChange = useCallback((nextQuery: string) => {
    setRegistrySearch(nextQuery);
    setRegistryPage(0);
  }, []);
  const closeSkillDetail = useCallback(() => {
    navigate(getToolsOwnedCollectionRoutePath("skills"));
  }, [navigate]);
  const handleCreateSkill = useCallback(
    (prompt?: string) => {
      navigate(getRootComposeRoutePath(), {
        state: {
          focusPrompt: true,
          initialPrompt: prompt ?? CREATE_SKILL_PROMPT,
          replaceInitialPrompt: true,
          createDraftKind: "skill",
        },
      });
    },
    [navigate],
  );
  const forkRegistrySkill = useCallback(
    (skill: RegistrySkill) => {
      navigate(getRootComposeRoutePath(), {
        state: {
          focusPrompt: true,
          initialPrompt: buildRegistrySkillReferencePrompt(skill),
          replaceInitialPrompt: true,
          createDraftKind: "skill",
        },
      });
    },
    [navigate],
  );
  const registryDetail = registryDetailQuery.data ?? null;
  const selectedLocalRegistrySkill = selectedRegistrySkill
    ? findLocalRegistrySkill(selectedRegistrySkill)
    : null;
  return (
    <>
      {routeSkillId !== undefined && hasError ? (
        <ResourceListState
          state="error"
          message="Couldn't load skill."
          layout="detail"
          onRetry={() => void skillsQuery.refetch()}
        />
      ) : routeSkillId !== undefined && isLoading ? (
        <ResourceListState
          state="loading"
          message="Loading skill"
          layout="detail"
        />
      ) : routeSkillId !== undefined && selectedSkill === null ? (
        <ResourceListState
          state="empty"
          message="Skill not found."
          layout="detail"
        />
      ) : selectedSkill ? (
        <SkillDetailPage
          projectId={PERSONAL_PROJECT_ID}
          skill={selectedSkill}
          onClose={closeSkillDetail}
          onEdit={editSkillViaThread}
        />
      ) : routeRegistrySkillId !== undefined &&
        selectedRegistrySkill === null ? (
        <ResourceListState
          state={registryEntryQuery.isError ? "error" : "loading"}
          message={
            registryEntryQuery.isError
              ? "This registry skill could not be loaded."
              : "Loading registry skill"
          }
          layout="detail"
          onRetry={() => void registryEntryQuery.refetch()}
        />
      ) : selectedRegistrySkill && registryDetailQuery.isLoading ? (
        <ResourceListState
          state="loading"
          message="Checking skill source"
          layout="detail"
        />
      ) : selectedRegistrySkill &&
        (registryDetailQuery.isError || registryDetail === null) ? (
        <ResourceListState
          state="error"
          message="This registry skill is no longer available from its source."
          layout="detail"
          onRetry={() => void registryDetailQuery.refetch()}
        />
      ) : selectedRegistrySkill && registryDetail ? (
        <RegistrySkillDetailView
          skill={selectedRegistrySkill}
          detail={registryDetail}
          localSkill={selectedLocalRegistrySkill}
          localPath={selectedLocalRegistrySkill?.filePath ?? null}
          onRetry={() => void registryDetailQuery.refetch()}
          onFork={forkRegistrySkill}
          onEditLocalSkill={editSkillViaThread}
        />
      ) : (
        <SkillsOverview
          skills={skills}
          providerRoster={providerRoster}
          isLoading={isLoading}
          hasError={hasError}
          query={libraryQuery}
          activeMode={isRegistryBrowseRoute ? "browse" : "library"}
          browseContent={
            <RegistrySkillsBrowsePage
              skills={registrySkills}
              action={
                <CreateWithTemplatesButton
                  kind="skill"
                  label="New bb skill"
                  onCreate={handleCreateSkill}
                />
              }
              pendingSkillIds={pendingRegistrySkillIds}
              unknownInstallSkillIds={unknownInstallSkillIds}
              isLoading={
                registryQuery.isFetching && loadedRegistrySkills.length === 0
              }
              loadingMore={
                registryQuery.isFetching && loadedRegistrySkills.length > 0
              }
              hasMore={
                loadedRegistry.search === trimmedRegistrySearch &&
                loadedRegistry.hasMore
              }
              hasError={registryQuery.isError}
              query={registrySearch}
              onRetry={() => void registryQuery.refetch()}
              onQueryChange={handleRegistryQueryChange}
              onLoadMore={() => {
                if (!registryQuery.isFetching) {
                  setRegistryPage((current) => current + 1);
                }
              }}
              onFork={forkRegistrySkill}
              onSelect={openRegistrySkill}
            />
          }
          onCreateSkill={handleCreateSkill}
          onSelectSkill={openSkill}
          onPrefetchSkill={(skill) =>
            prefetchSkillDetail(queryClient, PERSONAL_PROJECT_ID, skill)
          }
          onQueryChange={setLibraryQuery}
          onRetry={() => void skillsQuery.refetch()}
        />
      )}
    </>
  );
}
