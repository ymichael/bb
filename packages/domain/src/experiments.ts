import { z } from "zod";

export const experimentKeys = [
  "changelogPreview",
  "editMessages",
  "mobileApp",
  "sidebarProgressiveDisclosure",
  "timelineWindowing",
] as const;
export const experimentKeySchema = z.enum(experimentKeys);
export type ExperimentKey = z.infer<typeof experimentKeySchema>;

export const experimentsSchema = z.record(experimentKeySchema, z.boolean());
export type Experiments = z.infer<typeof experimentsSchema>;

export const defaultExperiments: Experiments = {
  changelogPreview: false,
  editMessages: true,
  mobileApp: false,
  sidebarProgressiveDisclosure: false,
  timelineWindowing: false,
};
