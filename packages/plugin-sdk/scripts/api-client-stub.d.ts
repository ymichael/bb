export type PublicApiFetch = (...args: unknown[]) => unknown;
export interface PublicApiClientOptions {
  [key: string]: unknown;
}
export declare function createPublicApiClient(...args: unknown[]): unknown;
export declare function createApiClient(...args: unknown[]): unknown;
export type ApiClient = unknown;
