
import type { FuzzyFileSearchResult } from "./FuzzyFileSearchResult.js";

export type FuzzyFileSearchSessionUpdatedNotification = { sessionId: string, query: string, files: Array<FuzzyFileSearchResult>, };
