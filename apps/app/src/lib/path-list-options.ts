export const DEFAULT_PATH_LIST_LIMIT = 1000;

export interface PathListOptions {
  limit: number;
  query: string | null;
  includeFiles: boolean;
  includeDirectories: boolean;
}

export const DEFAULT_FILE_ONLY_PATH_LIST_OPTIONS: PathListOptions = {
  limit: DEFAULT_PATH_LIST_LIMIT,
  query: null,
  includeFiles: true,
  includeDirectories: false,
};
