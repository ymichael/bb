import type { ReactNode } from "react";
import type { ComposerView } from "@get-bb/plugin-sdk";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { useResolvedComposerBanners } from "./composer-slot-hooks";
import { PluginSlotMount } from "./PluginSlotMount";
import {
  composerScopeIdentity,
  PluginComposerViewProvider,
  useOptionalPluginComposerView,
} from "./plugin-composer-host";

export function ComposerBannersSlot({
  view,
  children,
  ownerPlacement = "after",
}: {
  view?: ComposerView;
  children?: ReactNode;
  ownerPlacement?: "before" | "after";
}) {
  return view === undefined ? (
    <ComposerBannerRows ownerPlacement={ownerPlacement}>
      {children}
    </ComposerBannerRows>
  ) : (
    <PluginComposerViewProvider value={view}>
      <ComposerBannerRows ownerPlacement={ownerPlacement}>
        {children}
      </ComposerBannerRows>
    </PluginComposerViewProvider>
  );
}

function ComposerBannerRows({
  children,
  ownerPlacement,
}: {
  children?: ReactNode;
  ownerPlacement: "before" | "after";
}) {
  const view = useOptionalPluginComposerView();
  const banners = useResolvedComposerBanners(view?.scope.kind ?? null);
  const scopeKey =
    view === undefined ? null : composerScopeIdentity(view.scope);
  const pluginRows = banners.map(
    ({ key, pluginId, customizationId, banner }) => {
      const slotId = `${customizationId}/${banner.id}`;
      return (
        <PluginSlotMount
          key={`${key}/${scopeKey ?? "unbound"}`}
          pluginId={pluginId}
          slotKind="composerBanner"
          slotId={slotId}
          crashFallback={<></>}
        >
          {banner.chrome === "bare" ? (
            <banner.component />
          ) : (
            <PromptStackCard ariaLabel={pluginId} className="empty:hidden">
              <banner.component />
            </PromptStackCard>
          )}
        </PluginSlotMount>
      );
    },
  );

  return (
    <>
      {ownerPlacement === "before" ? children : null}
      {pluginRows}
      {ownerPlacement === "after" ? children : null}
    </>
  );
}
