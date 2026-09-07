import { useMemo, useState, type CSSProperties } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AppSettings, ProviderInfo } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { ProviderIconMark } from "./ProviderIconMark";

interface ProvidersSettingsSectionProps {
  disabled: boolean;
  generalSettings: AppSettings;
  onGeneralSettingsChange: (next: AppSettings) => Promise<unknown> | void;
}

const restrictProviderDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

const providerDragModifiers: Modifier[] = [restrictProviderDragToVerticalAxis];

function applyProviderOrder(
  providers: readonly ProviderInfo[],
  ids: readonly string[] | null,
): readonly ProviderInfo[] {
  if (
    ids === null ||
    providers.length !== ids.length ||
    providers.some((provider) => !ids.includes(provider.id))
  ) {
    return providers;
  }
  const providersById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  return ids.flatMap((id) => {
    const provider = providersById.get(id);
    return provider === undefined ? [] : [provider];
  });
}

export function reorderProviderIds(
  ids: readonly string[],
  activeId: string,
  overId: string,
): string[] | null {
  const activeIndex = ids.indexOf(activeId);
  const overIndex = ids.indexOf(overId);
  if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
    return null;
  }
  return arrayMove([...ids], activeIndex, overIndex);
}

interface SortableProviderRowProps {
  disabled: boolean;
  generalSettings: AppSettings;
  index: number;
  onGeneralSettingsChange: ProvidersSettingsSectionProps["onGeneralSettingsChange"];
  provider: ProviderInfo;
}

function SortableProviderRow({
  disabled,
  generalSettings,
  index,
  onGeneralSettingsChange,
  provider,
}: SortableProviderRowProps) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: provider.id, disabled });
  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Translate.toString(transform),
      transition,
    }),
    [transform, transition],
  );
  const ProviderIcon = getProviderIconInfo(provider.id, provider)?.icon;
  const isDefault =
    generalSettings.defaultProviderId === provider.id ||
    (generalSettings.defaultProviderId === null && index === 0);

  return (
    <SettingsRow
      ref={setNodeRef}
      style={style}
      className={cn(
        "group/provider-row",
        isDragging && "relative z-10 rounded-md bg-card opacity-90 shadow-lift",
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "-ml-2 h-8 w-7 shrink-0 touch-none text-muted-foreground",
          !disabled && "cursor-grab active:cursor-grabbing",
        )}
        disabled={disabled}
        aria-label={`Reorder ${provider.displayName}`}
        {...attributes}
        {...listeners}
      >
        <Icon name="DragDropVertical" aria-hidden="true" />
      </Button>
      <span className="flex size-5 items-center justify-center">
        {ProviderIcon ? (
          <ProviderIconMark
            provider={provider}
            icon={ProviderIcon}
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        ) : (
          <Icon name="Zap" className="text-muted-foreground" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">
        {provider.displayName}
      </span>
      {!provider.available ? <SettingsBadge>Unavailable</SettingsBadge> : null}
      {isDefault ? (
        <SettingsBadge>Default</SettingsBadge>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || !provider.available}
          onClick={() =>
            onGeneralSettingsChange({
              ...generalSettings,
              defaultProviderId: provider.id,
            })
          }
        >
          Make default
        </Button>
      )}
    </SettingsRow>
  );
}

export function ProvidersSettingsSection({
  disabled,
  generalSettings,
  onGeneralSettingsChange,
}: ProvidersSettingsSectionProps) {
  const providersQuery = useSystemProviders();
  const serverProviders: ProviderInfo[] = providersQuery.data ?? [];
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);
  const providers = applyProviderOrder(serverProviders, optimisticOrder);
  const ids = providers.map((provider) => provider.id);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    if (
      disabled ||
      typeof event.active.id !== "string" ||
      typeof event.over?.id !== "string"
    ) {
      return;
    }
    const next = reorderProviderIds(ids, event.active.id, event.over.id);
    if (next === null) return;
    setOptimisticOrder(next);
    let write: Promise<unknown> | void;
    try {
      write = onGeneralSettingsChange({
        ...generalSettings,
        providerOrder: next,
      });
    } catch {
      setOptimisticOrder(null);
      return;
    }
    void Promise.resolve(write)
      .catch(() => undefined)
      .finally(() => setOptimisticOrder(null));
  };

  return (
    <SettingsSection
      title="Providers"
      description="Set the default agent and its order in provider pickers. Configure each provider on its plugin page under Plugins."
    >
      {providersQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading providers…</p>
      ) : providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agent provider is enabled. Enable a provider plugin under Plugins.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={providerDragModifiers}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <SettingsRowList>
              {providers.map((provider, index) => (
                <SortableProviderRow
                  key={provider.id}
                  disabled={disabled}
                  generalSettings={generalSettings}
                  index={index}
                  onGeneralSettingsChange={onGeneralSettingsChange}
                  provider={provider}
                />
              ))}
            </SettingsRowList>
          </SortableContext>
        </DndContext>
      )}
    </SettingsSection>
  );
}
