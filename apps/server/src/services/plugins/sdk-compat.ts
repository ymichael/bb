import semver from "semver";
import { PLUGIN_SDK_VERSION } from "@bb/domain";

export function isPluginSdkRangeSatisfied(range: string): boolean {
  if (semver.validRange(range) === null) return false;
  if (semver.satisfies(PLUGIN_SDK_VERSION, range)) return true;
  const floor = semver.minVersion(range);
  if (floor === null) return false;
  if (semver.major(floor) !== semver.major(PLUGIN_SDK_VERSION)) return false;
  return semver.gte(PLUGIN_SDK_VERSION, floor);
}

export function pluginSdkRangeProblem(range: string): string {
  return `requires bb plugin SDK ${range}, running SDK is ${PLUGIN_SDK_VERSION}`;
}
