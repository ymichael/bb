
import type { AdditionalFileSystemPermissions } from "./AdditionalFileSystemPermissions.js";
import type { AdditionalNetworkPermissions } from "./AdditionalNetworkPermissions.js";

export type GrantedPermissionProfile = { network?: AdditionalNetworkPermissions, fileSystem?: AdditionalFileSystemPermissions, };
