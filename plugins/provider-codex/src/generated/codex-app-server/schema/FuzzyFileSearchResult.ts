
import type { FuzzyFileSearchMatchType } from "./FuzzyFileSearchMatchType.js";

export type FuzzyFileSearchResult = { root: string, path: string, match_type: FuzzyFileSearchMatchType, file_name: string, score: number, indices: Array<number> | null, };
