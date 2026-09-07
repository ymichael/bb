import { useEffect, useState, type ReactNode } from "react";
import type { SkillSummary } from "@bb/server-contract";
import { ResourceInfiniteScrollSentinel } from "@bb/shared-ui/resource-pagination";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  ResourceBrowseCard,
  ResourceBrowseGrid,
  ResourceCardStat,
  ResourceCollectionViewport,
  ResourceInstallControl,
  ResourceListState,
  ResourceOverflowMenu,
  ResourceToolbar,
} from "@bb/shared-ui/resource-list";
import {
  formatInstallCount,
  formatRegistrySource,
  REGISTRY_PAGE_SIZE,
} from "@/lib/skills-registry";
import type { RegistrySkill, RegistrySkillDetail } from "@/lib/skills-registry";
import { cn } from "@bb/shared-ui/lib/utils";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";
import { SkillDetailView } from "@/components/tools/SkillDetailView";
import { TOOLS_PAGE_BAND_CLASSES } from "@/components/tools/tools-navigation";

function RegistrySkillActions({
  skillName,
  onFork,
  presentation = "label",
}: {
  skillName: string;
  onFork: () => void;
  presentation?: "label" | "icon";
}) {
  return (
    <ResourceInstallControl
      accessibleLabel={`Fork ${skillName} into a new bb skill`}
      label="Fork"
      icon="Fork"
      presentation={presentation}
      tooltip={`Fork ${skillName}`}
      onAction={onFork}
    />
  );
}

function RegistrySkillSocialProof({
  skill,
  installsKnown,
}: {
  skill: RegistrySkill;
  installsKnown: boolean;
}) {
  const installs = formatInstallCount(skill.installs);
  const stars = skill.stars !== null ? formatInstallCount(skill.stars) : null;
  return (
    <span className="inline-flex flex-nowrap items-center gap-1 text-[11px] leading-none">
      {installsKnown ? (
        <ResourceCardStat
          icon="Download"
          iconClassName="text-success"
          accessibleLabel={`${installs} installs`}
        >
          {installs}
        </ResourceCardStat>
      ) : null}
      {stars !== null ? (
        <ResourceCardStat
          icon="Star"
          iconClassName="fill-attention/20 text-attention"
          accessibleLabel={`${stars} stars`}
        >
          {stars}
        </ResourceCardStat>
      ) : null}
    </span>
  );
}

function RegistrySkillSourceItem({
  skill,
  installsKnown,
  onFork,
  onSelect,
}: {
  skill: RegistrySkill;
  installsKnown: boolean;
  onFork: (skill: RegistrySkill) => void;
  onSelect: (skill: RegistrySkill) => void;
}) {
  return (
    <ResourceBrowseCard
      title={skill.name}
      byline={`by ${formatRegistrySource(skill.source)}`}
      description={skill.summary ?? undefined}
      openLabel={`View details for ${skill.name}`}
      onOpen={() => onSelect(skill)}
      headerAction={
        <RegistrySkillActions
          skillName={skill.name}
          onFork={() => onFork(skill)}
          presentation="icon"
        />
      }
      footerMeta={
        <RegistrySkillSocialProof skill={skill} installsKnown={installsKnown} />
      }
    />
  );
}

function RegistrySkillSourceItemSkeleton({ skillName }: { skillName: string }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${skillName}`}
      className="grid min-h-28 w-full grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr_auto] gap-2 rounded-lg border border-border bg-card p-3"
    >
      <span className="sr-only">Loading {skillName}</span>
      <Skeleton className="h-3.5 w-32 max-w-full self-center" />
      <Skeleton className="size-7 rounded-md" />
      <span className="col-span-2 row-start-2 space-y-1.5 self-center">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </span>
      <Skeleton className="h-3 w-28 max-w-full self-end" />
      <Skeleton className="h-3 w-20 self-end justify-self-end" />
    </div>
  );
}

export function RegistrySkillsBrowsePage({
  skills,
  pendingSkillIds,
  unknownInstallSkillIds,
  isLoading,
  loadingMore,
  hasMore,
  hasError,
  query,
  action,
  onRetry,
  onQueryChange,
  onLoadMore,
  onFork,
  onSelect,
}: {
  skills: readonly RegistrySkill[];
  pendingSkillIds: ReadonlySet<string>;
  unknownInstallSkillIds: ReadonlySet<string>;
  isLoading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  hasError: boolean;
  query: string;
  action?: ReactNode;
  onRetry?: () => void;
  onQueryChange: (query: string) => void;
  onLoadMore: () => void;
  onFork: (skill: RegistrySkill) => void;
  onSelect: (skill: RegistrySkill) => void;
}) {
  return (
    <ResourceCollectionViewport
      scrollId="skills-browse-results"
      bandClassName={TOOLS_PAGE_BAND_CLASSES}
      toolbar={
        <ResourceToolbar
          searchValue={query}
          searchPlaceholder="Search skills"
          onSearchChange={onQueryChange}
          action={action}
        />
      }
    >
      <div className={cn("space-y-4", TOOLS_PAGE_BAND_CLASSES)}>
        {hasError && skills.length === 0 ? (
          <ResourceListState
            state="error"
            message="Couldn't load skills.sh."
            onRetry={onRetry}
          />
        ) : isLoading ? (
          <ResourceListState
            state="loading"
            message="Loading skills.sh skills"
            loadingRows={REGISTRY_PAGE_SIZE}
          />
        ) : skills.length === 0 ? (
          <ResourceListState
            state="empty"
            message={
              query.trim().length === 0
                ? "No skills.sh resources available."
                : `No skills.sh resources match "${query}"`
            }
          />
        ) : (
          <>
            <ResourceBrowseGrid>
              {skills.map((skill) =>
                pendingSkillIds.has(skill.id) ? (
                  <RegistrySkillSourceItemSkeleton
                    key={skill.id}
                    skillName={skill.name}
                  />
                ) : (
                  <RegistrySkillSourceItem
                    key={skill.id}
                    skill={skill}
                    installsKnown={!unknownInstallSkillIds.has(skill.id)}
                    onFork={onFork}
                    onSelect={onSelect}
                  />
                ),
              )}
            </ResourceBrowseGrid>
            {hasError ? (
              <ResourceListState
                state="error"
                message="Couldn't load more from skills.sh."
                onRetry={onRetry}
              />
            ) : null}
          </>
        )}
        {hasError || isLoading ? null : (
          <ResourceInfiniteScrollSentinel
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={onLoadMore}
          />
        )}
      </div>
    </ResourceCollectionViewport>
  );
}

export function RegistrySkillDetailView({
  skill,
  detail,
  localSkill,
  localPath,
  onRetry,
  onFork,
  onEditLocalSkill,
}: {
  skill: RegistrySkill;
  detail: RegistrySkillDetail;
  localSkill: SkillSummary | null;
  localPath: string | null;
  onRetry: () => void;
  onFork: (skill: RegistrySkill) => void;
  onEditLocalSkill: (skill: SkillSummary) => void;
}) {
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  useEffect(() => setSelectedPath("SKILL.md"), [skill.id]);
  const { canOpenPreferredFileTarget, openPathInPreferredFileTarget } =
    useLocalOpenTargets({ enabled: localPath !== null });
  const files = detail?.files ?? [];
  const selectedFile =
    files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const path = localPath ?? `skills.sh/${skill.source}/${skill.skillId}`;
  return (
    <SkillDetailView
      title={skill.name}
      path={path}
      pathHref={localPath === null ? skill.url : undefined}
      headerActions={
        <RegistrySkillActions
          skillName={skill.name}
          onFork={() => onFork(skill)}
        />
      }
      overflowMenu={
        localSkill !== null && localPath !== null ? (
          <ResourceOverflowMenu
            label={`${skill.name} actions`}
            items={[
              {
                label: "Edit",
                icon: "Edit",
                onSelect: () => onEditLocalSkill(localSkill),
              },
              {
                label: "Open source",
                icon: "ExternalLink",
                disabled: !canOpenPreferredFileTarget,
                disabledReason: canOpenPreferredFileTarget
                  ? undefined
                  : "No editor configured",
                onSelect: () => {
                  void openPathInPreferredFileTarget({
                    path: localPath,
                    lineNumber: null,
                  });
                },
              },
            ]}
          />
        ) : undefined
      }
      files={files.map((file) => file.path)}
      selectedPath={selectedFile?.path ?? selectedPath}
      onSelectFile={setSelectedPath}
      contentState={
        selectedFile
          ? { kind: "ready", content: selectedFile.contents }
          : {
              kind: "error",
              message: "The source does not include SKILL.md content.",
              onRetry,
            }
      }
    />
  );
}
