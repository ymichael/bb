
import type { GrantedPermissionProfile } from "./GrantedPermissionProfile.js";
import type { PermissionGrantScope } from "./PermissionGrantScope.js";

export type PermissionsRequestApprovalResponse = { permissions: GrantedPermissionProfile, scope: PermissionGrantScope,
strictAutoReview?: boolean, };
