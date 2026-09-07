import { useMemo, useRef, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@bb/shared-ui/command";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { searchPickerOptions } from "./picker-search";
import { useResetPickerScroll } from "./useResetPickerScroll";

const PROJECT_SEARCH_MIN_OPTIONS = 5;
const PROJECT_PICKER_ITEM_CLASS_NAME = "py-[0.3125rem] text-xs max-md:py-2";

export interface ProjectSelectorOption {
  id: string;
  name: string;
}

export interface ProjectSelectorCreateProjectConfig {
  onCreate: () => void;
  disabled?: boolean;
  isCreating?: boolean;
}

interface ProjectSelectorProps {
  projects: readonly ProjectSelectorOption[];
  value: string | null;
  onChange: (projectId: string | null) => void;
  allowNoProject?: boolean;
  createProject?: ProjectSelectorCreateProjectConfig;
  disabled?: boolean;
  isLoading?: boolean;
  showChevronWhenDisabled?: boolean;
  className?: string;
  defaultOpen?: boolean;
  modal?: boolean;
}

export function ProjectSelector({
  projects,
  value,
  onChange,
  allowNoProject = false,
  createProject,
  disabled: disabledProp = false,
  isLoading = false,
  showChevronWhenDisabled = false,
  className,
  defaultOpen,
  modal = true,
}: ProjectSelectorProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [searchQuery, setSearchQuery] = useState("");
  const commandRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useResetPickerScroll<HTMLDivElement>(searchQuery);
  const disabled = disabledProp || isLoading;
  const showSearch = projects.length > PROJECT_SEARCH_MIN_OPTIONS;
  const filteredProjects = useMemo(
    () =>
      showSearch
        ? searchPickerOptions({
            options: projects,
            query: searchQuery,
            getLabel: (project) => project.name,
          })
        : projects,
    [projects, searchQuery, showSearch],
  );
  const selected = value !== null ? projects.find((p) => p.id === value) : null;
  const fallback = !allowNoProject && !selected ? projects[0] : null;
  const triggerLabel = isLoading
    ? "Loading projects…"
    : (selected?.name ?? fallback?.name ?? "Work in a project");
  const compactTriggerLabel = isLoading
    ? "Loading…"
    : (selected?.name ?? fallback?.name ?? "No project");
  const triggerIcon =
    isLoading || selected || fallback ? "Folder" : "FolderPlus";
  const createProjectAction = createProject;
  const createProjectLabel = createProjectAction?.isCreating
    ? "Creating..."
    : "New project";
  const showActionSeparator =
    projects.length > 0 && (Boolean(createProjectAction) || allowNoProject);
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearchQuery("");
    }
  };
  const selectProject = (projectId: string | null) => {
    onChange(projectId);
    handleOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal={modal}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Project: ${triggerLabel}`}
          aria-busy={isLoading || undefined}
          disabled={disabled}
          data-promptbox-project-control=""
          className={cn(
            OPTION_BASE_CLASS_NAME,
            !disabled && OPTION_INTERACTIVE_CLASS_NAME,
            disabled && "cursor-default disabled:opacity-100",
            OPTION_MUTED_CLASS_NAME,
            className,
          )}
        >
          <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME}>
            <Icon
              name={triggerIcon}
              className="size-3.5 shrink-0"
              aria-hidden
            />
            <span className="min-w-0 truncate" data-promptbox-full-label="">
              {triggerLabel}
            </span>
            <span className="min-w-0 truncate" data-promptbox-compact-label="">
              {compactTriggerLabel}
            </span>
          </span>
          {disabled && !showChevronWhenDisabled ? null : (
            <Icon
              name="ChevronDown"
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Project"
        mobileTitle="Project"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (showSearch) {
            searchInputRef.current?.focus();
          } else {
            commandRef.current?.focus();
          }
        }}
        className="flex max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))] w-52 flex-col overflow-hidden p-0 max-md:min-h-0 max-md:w-full max-md:flex-1"
      >
        <Command
          ref={commandRef}
          label="Search projects"
          shouldFilter={false}
          className="min-h-0"
        >
          {showSearch ? (
            <CommandInput
              ref={searchInputRef}
              aria-label="Search projects"
              placeholder="Search projects"
              value={searchQuery}
              onValueChange={setSearchQuery}
              className="h-8 text-xs"
            />
          ) : null}
          <CommandList
            ref={listRef}
            className="min-h-0 max-h-none flex-1 overscroll-contain"
          >
            {projects.length > 0 ? (
              <CommandGroup heading="Project">
                {filteredProjects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={project.id}
                    keywords={[project.name]}
                    aria-current={project.id === value ? "true" : undefined}
                    onSelect={() => selectProject(project.id)}
                    className={PROJECT_PICKER_ITEM_CLASS_NAME}
                  >
                    <Icon
                      name="Folder"
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {project.name}
                    </span>
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto size-4",
                        project.id === value ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                  </CommandItem>
                ))}
                {showSearch && filteredProjects.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground max-md:py-2">
                    No projects found
                  </div>
                ) : null}
              </CommandGroup>
            ) : null}
            {showActionSeparator ? <CommandSeparator /> : null}
            {createProjectAction || allowNoProject ? (
              <CommandGroup
                heading={projects.length === 0 ? "Project" : undefined}
              >
                {createProjectAction ? (
                  <CommandItem
                    disabled={createProjectAction.disabled}
                    value="new-project"
                    onSelect={() => {
                      createProjectAction.onCreate();
                      handleOpenChange(false);
                    }}
                    className={PROJECT_PICKER_ITEM_CLASS_NAME}
                  >
                    <Icon
                      name="FolderPlus"
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                    {createProjectLabel}
                  </CommandItem>
                ) : null}
                {allowNoProject ? (
                  <CommandItem
                    value="no-project"
                    aria-current={value === null ? "true" : undefined}
                    onSelect={() => selectProject(null)}
                    className={PROJECT_PICKER_ITEM_CLASS_NAME}
                  >
                    <Icon
                      name="FolderMinus"
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                    Don&apos;t work in a project
                    <Icon
                      name="Check"
                      className={cn(
                        "ml-auto size-4",
                        value === null ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
