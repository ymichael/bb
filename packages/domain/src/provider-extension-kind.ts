import { z } from "zod";

export const EXTENSION_KIND_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/u;

export type ExtensionKind = `${string}/${string}`;

export function isExtensionKind(value: string): value is ExtensionKind {
  return EXTENSION_KIND_PATTERN.test(value);
}

export const extensionKindSchema = z.string().refine(isExtensionKind, {
  message:
    'extension kinds are "<pluginId>/<name>" (lowercase letters, digits, and "-")',
});

export function parseExtensionKind(kind: ExtensionKind): {
  pluginId: string;
  name: string;
} {
  const separator = kind.indexOf("/");
  return {
    pluginId: kind.slice(0, separator),
    name: kind.slice(separator + 1),
  };
}
