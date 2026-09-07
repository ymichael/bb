import {
  registrySkillDetailSchema,
  registrySkillEntriesRequestSchema,
  registrySkillEntriesResponseSchema,
  registrySkillInstallRequestSchema,
  registrySkillInstallResponseSchema,
  registryRepositoryStarsSchema,
  registrySkillSchema,
  registrySkillsPageSchema,
  type DeleteSkillRequest,
  type RegistryRepositoryStars,
  type RegistrySkill,
  type RegistrySkillDetail,
  type RegistrySkillEntriesResponse,
  type RegistrySkillInstallResponse,
  type RegistrySkillsPage,
  type SkillContentResponse,
  type SkillFilesResponse,
  type SkillListResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface SkillWorkspaceArgs {
  projectId: string;
  environmentId: string | null;
}

export interface SkillListArgs extends SkillWorkspaceArgs {
  signal?: AbortSignal;
}

export interface SkillIdentityArgs extends SkillListArgs {
  skillId: string;
}

export interface SkillContentArgs extends SkillIdentityArgs {
  path: string;
}

export interface SkillUpdateArgs extends SkillWorkspaceArgs {
  skillId: string;
  content: string;
  revision: string;
}

export interface SkillDeleteArgs extends SkillWorkspaceArgs {
  skillId: string;
}

export interface AbortableArgs {
  signal?: AbortSignal;
}

export interface RegistrySkillsSearchArgs extends AbortableArgs {
  query?: string;
  page?: number;
  perPage?: number;
}

export interface RegistrySkillIdArgs extends AbortableArgs {
  registrySkillId: string;
}

export interface RegistrySkillEntriesArgs extends AbortableArgs {
  registrySkillIds: readonly string[];
}

export interface RegistrySkillSourceArgs extends AbortableArgs {
  source: string;
  skillId: string;
}

export interface RegistryRepositoryArgs extends AbortableArgs {
  source: string;
}

export interface RegistrySkillInstallArgs {
  registrySkillId: string;
}

export interface SkillsRegistryArea {
  detail(args: RegistrySkillSourceArgs): Promise<RegistrySkillDetail>;
  entries(
    args: RegistrySkillEntriesArgs,
  ): Promise<RegistrySkillEntriesResponse>;
  get(args: RegistrySkillIdArgs): Promise<RegistrySkill>;
  install(
    args: RegistrySkillInstallArgs,
  ): Promise<RegistrySkillInstallResponse>;
  repositoryStars(
    args: RegistryRepositoryArgs,
  ): Promise<RegistryRepositoryStars>;
  search(args?: RegistrySkillsSearchArgs): Promise<RegistrySkillsPage>;
}

export interface SkillsArea {
  getContent(args: SkillContentArgs): Promise<SkillContentResponse>;
  list(args: SkillListArgs): Promise<SkillListResponse>;
  listFiles(args: SkillIdentityArgs): Promise<SkillFilesResponse>;
  registry: SkillsRegistryArea;
  remove(args: SkillDeleteArgs): Promise<{ deletedPath: string }>;
  update(
    args: SkillUpdateArgs,
  ): Promise<{ filePath: string; revision: string }>;
}

export function createSkillsArea(args: CreateSdkAreaArgs): SkillsArea {
  const { transport } = args;

  async function requestParsed<T>(
    path: string,
    schema: { parse(value: unknown): T },
    init?: RequestInit,
  ): Promise<T> {
    const baseUrl = transport.baseUrl.replace(/\/$/u, "");
    const response = await transport.resolve(
      transport.fetch(`${baseUrl}${path}`, init),
    );
    return schema.parse(await response.json());
  }

  const registry: SkillsRegistryArea = {
    async detail(input) {
      const query = new URLSearchParams({
        source: input.source,
        skillId: input.skillId,
      });
      return requestParsed(
        `/api/v1/skills-registry/detail?${query.toString()}`,
        registrySkillDetailSchema,
        { signal: input.signal },
      );
    },
    async entries(input) {
      const body = registrySkillEntriesRequestSchema.parse({
        ids: [...input.registrySkillIds],
      });
      return requestParsed(
        "/api/v1/skills-registry/entries",
        registrySkillEntriesResponseSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: input.signal,
        },
      );
    },
    async get(input) {
      const query = new URLSearchParams({ id: input.registrySkillId });
      return requestParsed(
        `/api/v1/skills-registry/entry?${query.toString()}`,
        registrySkillSchema,
        { signal: input.signal },
      );
    },
    async install(input) {
      const body = registrySkillInstallRequestSchema.parse(input);
      return requestParsed(
        "/api/v1/skills-registry/install",
        registrySkillInstallResponseSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    },
    async repositoryStars(input) {
      const query = new URLSearchParams({ source: input.source });
      return requestParsed(
        `/api/v1/skills-registry/repository-stars?${query.toString()}`,
        registryRepositoryStarsSchema,
        { signal: input.signal },
      );
    },
    async search(input = {}) {
      const query = new URLSearchParams({
        page: String(input.page ?? 0),
        perPage: String(input.perPage ?? 24),
      });
      if (input.query?.trim()) query.set("q", input.query.trim());
      return requestParsed(
        `/api/v1/skills-registry?${query.toString()}`,
        registrySkillsPageSchema,
        { signal: input.signal },
      );
    },
  };

  return {
    async getContent(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.content.$get(
          {
            param: { id: input.projectId },
            query: {
              skillId: input.skillId,
              path: input.path,
              environmentId: input.environmentId ?? "",
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.$get(
          {
            param: { id: input.projectId },
            query: { environmentId: input.environmentId ?? "" },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async listFiles(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.files.$get(
          {
            param: { id: input.projectId },
            query: {
              skillId: input.skillId,
              environmentId: input.environmentId ?? "",
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    registry,
    async remove(input) {
      const body: DeleteSkillRequest = {
        skillId: input.skillId,
        environmentId: input.environmentId,
      };
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.$delete({
          param: { id: input.projectId },
          json: body,
        }),
      );
    },
    async update(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.content.$patch({
          param: { id: input.projectId },
          json: {
            skillId: input.skillId,
            environmentId: input.environmentId,
            content: input.content,
            revision: input.revision,
          },
        }),
      );
    },
  };
}
