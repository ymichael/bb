import { describe, expect, it } from "vitest";
import { pluginSdkAliasFor } from "../../../src/services/plugins/plugin-runtime.js";

describe("pluginSdkAliasFor", () => {
  it("resolves the pre-rename specifier to the same SDK runtime bundle", () => {
    const alias = pluginSdkAliasFor("/srv/plugin-sdk-runtime.js");

    expect(alias["@get-bb/plugin-sdk"]).toBe("/srv/plugin-sdk-runtime.js");
    expect(alias["@bb/plugin-sdk"]).toBe("/srv/plugin-sdk-runtime.js");
  });
});
