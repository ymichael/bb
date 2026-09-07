import type { ReactElement } from "react";
import type { IconName } from "@bb/shared-ui/icon";

export interface ShowcaseArchetype {
  id: string;
  noun: string;
  title: string;
  hook: string;
  capability: string;
  icon: IconName;
  accentToken: string;
  brief: string;
}

type ShowcaseScene = (props: { accentToken: string }) => ReactElement;

export type ShowcaseScenes = Record<string, ShowcaseScene>;
