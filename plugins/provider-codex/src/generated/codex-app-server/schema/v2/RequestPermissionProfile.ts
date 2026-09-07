
import type { AdditionalFileSystemPermissions } from "./AdditionalFileSystemPermissions.js";
import type { AdditionalNetworkPermissions } from "./AdditionalNetworkPermissions.js";

export type RequestPermissionProfile = { network: AdditionalNetworkPermissions | null, fileSystem: AdditionalFileSystemPermissions | null, };
