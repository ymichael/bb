export const INITIAL_PROMPT_MAX_LENGTH = 8000;

export const INITIAL_PROMPT_SEARCH_PARAM = "initialPrompt";

export function readInitialPromptFromSearch(search: string): string | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const raw = params.get(INITIAL_PROMPT_SEARCH_PARAM);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, INITIAL_PROMPT_MAX_LENGTH);
}

export function stripInitialPromptFromSearch(search: string): string {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return search;
  }
  params.delete(INITIAL_PROMPT_SEARCH_PARAM);
  const rest = params.toString();
  return rest.length > 0 ? `?${rest}` : "";
}
