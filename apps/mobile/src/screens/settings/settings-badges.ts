import { useTheme } from "@/theme";

const SYSTEM_BADGE_COLORS = {
  light: {
    gray: "#8e8e93",
    purple: "#af52de",
    pink: "#ff2d55",
    indigo: "#5856d6",
    teal: "#30b0c7",
    discord: "#5865f2",
    github: "#24292f",
  },
  dark: {
    gray: "#8e8e93",
    purple: "#bf5af2",
    pink: "#ff375f",
    indigo: "#5e5ce6",
    teal: "#40c8e0",
    discord: "#5865f2",
    github: "#6e7681",
  },
} as const;

export interface BadgeColors {
  blue: string;
  green: string;
  orange: string;
  red: string;
  gray: string;
  purple: string;
  pink: string;
  indigo: string;
  teal: string;
  discord: string;
  github: string;
}

export function useBadgeColors(): BadgeColors {
  const { tokens, mode } = useTheme();
  return {
    blue: tokens.primary,
    green: tokens.success,
    orange: tokens.warning,
    red: tokens.destructive,
    ...SYSTEM_BADGE_COLORS[mode],
  };
}
