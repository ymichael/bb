

export type WebSearchAction = { "type": "search", query?: string, queries?: Array<string>, } | { "type": "open_page", url?: string, } | { "type": "find_in_page", url?: string, pattern?: string, } | { "type": "other" };
