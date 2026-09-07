import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/contract.js";
import { TASK_SORTS, type TaskSort } from "../../shared/pagination.js";
import { EMPTY_FILTERS, type ListFilterState } from "./filter-bar.js";

export const LIST_PREFERENCE_STORAGE_KEY = "bb-tasks:list-preferences";
export const LIST_PREFERENCE_VERSION = 1 as const;

type ListPreferenceScope = "all" | "active" | `project:${string}`;

export interface ListPreference {
  filters: ListFilterState;
  sort: TaskSort;
}

export const DEFAULT_LIST_PREFERENCE: ListPreference = {
  filters: EMPTY_FILTERS,
  sort: "manual",
};

interface StoredDocumentV1 {
  version: typeof LIST_PREFERENCE_VERSION;
  scopes: Record<string, unknown>;
}

export function listPreferenceScope(
  projectId: string | null,
  activeOnly: boolean,
): ListPreferenceScope {
  if (activeOnly) return "active";
  if (projectId !== null) return `project:${projectId}`;
  return "all";
}

const STATUS_SET = new Set<string>(TASK_STATUSES);
const PRIORITY_SET = new Set<string>(TASK_PRIORITIES);
const SORT_SET = new Set<string>(TASK_SORTS);

function uniqueValidStatuses(values: unknown): TaskStatus[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<TaskStatus>();
  const result: TaskStatus[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !STATUS_SET.has(value)) continue;
    const status = value as TaskStatus;
    if (seen.has(status)) continue;
    seen.add(status);
    result.push(status);
  }
  return result;
}

function uniqueValidPriorities(values: unknown): TaskPriority[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<TaskPriority>();
  const result: TaskPriority[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !PRIORITY_SET.has(value)) continue;
    const priority = value as TaskPriority;
    if (seen.has(priority)) continue;
    seen.add(priority);
    result.push(priority);
  }
  return result;
}

function uniqueLabelNames(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function sanitizeSort(value: unknown): TaskSort {
  if (typeof value === "string" && SORT_SET.has(value)) {
    return value as TaskSort;
  }
  return DEFAULT_LIST_PREFERENCE.sort;
}

export function sanitizeListPreference(raw: unknown): ListPreference {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      filters: { ...EMPTY_FILTERS },
      sort: DEFAULT_LIST_PREFERENCE.sort,
    };
  }
  const record = raw as Record<string, unknown>;
  const filtersRaw =
    record.filters !== undefined &&
    record.filters !== null &&
    typeof record.filters === "object" &&
    !Array.isArray(record.filters)
      ? (record.filters as Record<string, unknown>)
      : record;
  return {
    filters: {
      statuses: uniqueValidStatuses(filtersRaw.statuses),
      priorities: uniqueValidPriorities(filtersRaw.priorities),
      labelNames: uniqueLabelNames(filtersRaw.labelNames),
    },
    sort: sanitizeSort(record.sort),
  };
}

interface ParsedStorage {
  version: number | null;
  scopes: Record<string, unknown>;
  isFutureVersion: boolean;
}

function readStorage(): ParsedStorage | null {
  try {
    const raw = window.localStorage.getItem(LIST_PREFERENCE_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.scopes === null ||
      typeof record.scopes !== "object" ||
      Array.isArray(record.scopes)
    ) {
      return null;
    }
    const version =
      typeof record.version === "number" && Number.isFinite(record.version)
        ? record.version
        : null;
    const isFutureVersion =
      version !== null && version > LIST_PREFERENCE_VERSION;
    if (version !== null && version < LIST_PREFERENCE_VERSION) {
      return null;
    }
    return {
      version,
      scopes: record.scopes as Record<string, unknown>,
      isFutureVersion,
    };
  } catch {
    return null;
  }
}

export function loadListPreference(scope: ListPreferenceScope): ListPreference {
  const document = readStorage();
  if (document === null) {
    return {
      filters: { ...EMPTY_FILTERS },
      sort: DEFAULT_LIST_PREFERENCE.sort,
    };
  }
  return sanitizeListPreference(document.scopes[scope]);
}

export function storeListPreference(
  scope: ListPreferenceScope,
  preference: ListPreference,
): void {
  const sanitized = sanitizeListPreference(preference);
  try {
    const existing = readStorage();
    if (existing?.isFutureVersion) {
      return;
    }
    const scopes = { ...(existing?.scopes ?? {}) };
    scopes[scope] = sanitized;
    const document: StoredDocumentV1 = {
      version: LIST_PREFERENCE_VERSION,
      scopes,
    };
    window.localStorage.setItem(
      LIST_PREFERENCE_STORAGE_KEY,
      JSON.stringify(document),
    );
  } catch {}
}
