import { useEffect, useRef } from "react";
import { atom, getDefaultStore, useSetAtom } from "jotai";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  defaultFaviconColor,
  faviconColorPreferenceSchema,
  type AppThemeSelection,
  type FaviconColor,
  type FaviconColorPreference,
} from "@bb/domain";
import {
  DARK_COLOR_SCHEME_QUERY,
  getMediaQuerySnapshot,
  subscribeMediaQuery,
} from "@bb/shared-ui/hooks/use-media-query";
import { invalidateSystemConfig } from "@/hooks/cache-owners/system-cache-effects";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { sdk } from "@/lib/sdk";

export const FAVICON_COLOR_STORAGE_KEY = "bb.faviconColor";
export const FAVICON_COLOR_SERVER_SYNCED_STORAGE_KEY =
  "bb.faviconColor.serverSynced";

const FAVICON_BADGES = ["none", "unread"] as const;
type FaviconBadge = (typeof FAVICON_BADGES)[number];

export const FAVICON_COLOR_VALUES: Record<FaviconColor, string> = {
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#ffba18",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#0090ff",
  purple: "#8e4ec6",
  pink: "#d6409f",
};

function readCachedFaviconColor(): FaviconColorPreference {
  try {
    const parsed = faviconColorPreferenceSchema.safeParse(
      localStorage.getItem(FAVICON_COLOR_STORAGE_KEY),
    );
    return parsed.success ? parsed.data : defaultFaviconColor;
  } catch {
    return defaultFaviconColor;
  }
}

function cacheFaviconColor(color: FaviconColorPreference): void {
  try {
    if (color === defaultFaviconColor) {
      localStorage.removeItem(FAVICON_COLOR_STORAGE_KEY);
    } else {
      localStorage.setItem(FAVICON_COLOR_STORAGE_KEY, color);
    }
  } catch {}
}

function hasServerSyncedFaviconColor(): boolean {
  try {
    return (
      localStorage.getItem(FAVICON_COLOR_SERVER_SYNCED_STORAGE_KEY) === "true"
    );
  } catch {
    return false;
  }
}

function markServerSyncedFaviconColor(): void {
  try {
    localStorage.setItem(FAVICON_COLOR_SERVER_SYNCED_STORAGE_KEY, "true");
  } catch {}
}

const faviconColorAtom = atom<FaviconColorPreference>(readCachedFaviconColor());
const faviconBadgeAtom = atom<FaviconBadge>("none");

function setActiveFaviconColor(color: FaviconColorPreference): void {
  getDefaultStore().set(faviconColorAtom, color);
  cacheFaviconColor(color);
}

export function useFaviconColorSync(): void {
  const { data } = useSystemConfig();
  const appearance = data?.appearance;
  const queryClient = useQueryClient();
  const { mutate: updateAppearance } = useMutation({
    meta: {
      errorMessage: "Failed to update appearance.",
    },
    mutationFn: (selection: AppThemeSelection) => sdk.theme.set(selection),
    onSuccess: () => {
      invalidateSystemConfig({ queryClient });
    },
  });
  const legacyMigrationRequestedRef = useRef(false);

  useEffect(() => {
    if (!appearance) return;
    const legacy = readCachedFaviconColor();
    const needsMigration =
      !hasServerSyncedFaviconColor() &&
      !legacyMigrationRequestedRef.current &&
      legacy !== defaultFaviconColor &&
      appearance.faviconColor === defaultFaviconColor;
    if (needsMigration) {
      legacyMigrationRequestedRef.current = true;
      setActiveFaviconColor(legacy);
      updateAppearance(
        { themeId: appearance.themeId, faviconColor: legacy },
        { onSuccess: markServerSyncedFaviconColor },
      );
      return;
    }
    markServerSyncedFaviconColor();
    setActiveFaviconColor(appearance.faviconColor);
  }, [appearance, updateAppearance]);
}

export function useFaviconBadge(badge: FaviconBadge): void {
  const setFaviconBadge = useSetAtom(faviconBadgeAtom);

  useEffect(() => {
    setFaviconBadge(badge);
    return () => {
      setFaviconBadge("none");
    };
  }, [badge, setFaviconBadge]);
}

const FAVICON_SIZES = [32, 16] as const;
const UNREAD_BADGE_FILL = "#e00000";
const WEB_MANIFEST_LINK_ID = "app-manifest";
const APPLE_TOUCH_ICON_LINK_ID = "apple-touch-icon";

type FaviconSize = (typeof FAVICON_SIZES)[number];

interface FaviconRenderState {
  badge: FaviconBadge;
  colorPreference: FaviconColorPreference;
}

interface FaviconRenderRequest extends FaviconRenderState {
  baseHref: string;
}

interface RenderedFaviconLink {
  href: string;
  size: FaviconSize;
}

interface UnreadBadgeDot {
  centerX: number;
  centerY: number;
  radius: number;
}

export function getFaviconGlyphHref(): string {
  return import.meta.env.DEV ? "/favicon-32x32-dev.png" : "/favicon-32x32.png";
}

function getFaviconVariantSuffix(): string {
  if (import.meta.env.DEV) return "-dev";
  return getMediaQuerySnapshot(DARK_COLOR_SCHEME_QUERY) ? "-dark" : "";
}

function getFaviconLink(size: number): HTMLLinkElement | null {
  const element = document.getElementById(`favicon-${size}`);
  return element instanceof HTMLLinkElement ? element : null;
}

function getDocumentLink(id: string): HTMLLinkElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLLinkElement ? element : null;
}

function getTintedAssetSuffix(colorPreference: FaviconColorPreference): string {
  return colorPreference === defaultFaviconColor ? "" : `-${colorPreference}`;
}

function getPwaManifestHref(colorPreference: FaviconColorPreference): string {
  return `/manifest${getTintedAssetSuffix(colorPreference)}.webmanifest`;
}

function getAppleTouchIconHref(
  colorPreference: FaviconColorPreference,
): string {
  return `/apple-touch-icon${getTintedAssetSuffix(colorPreference)}.png`;
}

function applyInstallIconState(colorPreference: FaviconColorPreference): void {
  const manifestLink = getDocumentLink(WEB_MANIFEST_LINK_ID);
  if (manifestLink) manifestLink.href = getPwaManifestHref(colorPreference);

  const appleTouchIconLink = getDocumentLink(APPLE_TOUCH_ICON_LINK_ID);
  if (appleTouchIconLink) {
    appleTouchIconLink.href = getAppleTouchIconHref(colorPreference);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error(`Failed to load favicon image: ${src}`));
    image.src = src;
  });
}

const baseImageCache = new Map<string, Promise<HTMLImageElement>>();

function loadBaseImage(src: string): Promise<HTMLImageElement> {
  const cached = baseImageCache.get(src);
  if (cached) return cached;
  const pending = loadImage(src);
  baseImageCache.set(src, pending);
  pending.catch(() => {
    baseImageCache.delete(src);
  });
  return pending;
}

const STANDALONE_DISPLAY_MODE_QUERY = "(display-mode: standalone)";

async function createFaviconHref({
  badge,
  baseHref,
  colorPreference,
}: FaviconRenderRequest): Promise<string> {
  if (badge === "none" && colorPreference === "default") {
    return baseHref;
  }

  const image = await loadBaseImage(baseHref);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.drawImage(image, 0, 0);

  if (colorPreference !== "default") {
    context.globalCompositeOperation = "source-in";
    context.fillStyle = FAVICON_COLOR_VALUES[colorPreference];
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "source-over";
  }

  if (badge === "unread") {
    drawUnreadBadge(context, canvas.width, canvas.height);
  }

  return canvas.toDataURL("image/png");
}

function getUnreadBadgeDot(width: number, height: number): UnreadBadgeDot {
  const size = Math.min(width, height);
  const scale = size / 32;
  return {
    centerX: 28 * scale,
    centerY: 6 * scale,
    radius: 3.5 * scale,
  };
}

function drawUnreadBadge(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const badge = getUnreadBadgeDot(width, height);
  context.save();
  context.beginPath();
  context.arc(badge.centerX, badge.centerY, badge.radius, 0, Math.PI * 2);
  context.fillStyle = UNREAD_BADGE_FILL;
  context.fill();
  context.restore();
}

let applyToken = 0;

async function applyFaviconState(state: FaviconRenderState): Promise<void> {
  const token = ++applyToken;
  if (getMediaQuerySnapshot(STANDALONE_DISPLAY_MODE_QUERY)) return;
  const suffix = getFaviconVariantSuffix();
  const links = await Promise.all(
    FAVICON_SIZES.map(async (size): Promise<RenderedFaviconLink> => {
      const baseHref = `/favicon-${size}x${size}${suffix}.png`;
      const href = await createFaviconHref({
        badge: state.badge,
        baseHref,
        colorPreference: state.colorPreference,
      });
      return { href, size };
    }),
  );
  if (token !== applyToken) return;
  for (const { href, size } of links) {
    const link = getFaviconLink(size);
    if (link) link.href = href;
  }
}

let initialized = false;

export function initializeFavicon(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  const store = getDefaultStore();
  const apply = () => {
    const colorPreference = store.get(faviconColorAtom);
    applyInstallIconState(colorPreference);

    void applyFaviconState({
      badge: store.get(faviconBadgeAtom),
      colorPreference,
    }).catch(() => {});
  };
  store.sub(faviconColorAtom, apply);
  store.sub(faviconBadgeAtom, apply);
  subscribeMediaQuery(DARK_COLOR_SCHEME_QUERY, apply);
  apply();
}
