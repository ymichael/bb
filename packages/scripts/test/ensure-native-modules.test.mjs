import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureNativeModules,
  verifyNativeModule,
} from "../../../scripts/ensure-native-modules.mjs";

const scriptUrl = new URL(
  "../../../scripts/ensure-native-modules.mjs",
  import.meta.url,
).href;

function createBetterSqliteRequire(
  initialError,
  packageJsonPath = "/tmp/fake-node-modules/better-sqlite3/package.json",
) {
  const state = {
    constructorError: initialError,
    constructorCalls: 0,
  };

  function Database() {
    state.constructorCalls += 1;
    if (state.constructorError !== null) {
      throw state.constructorError;
    }
  }

  Database.prototype.close = vi.fn();

  function requireModule(request) {
    if (request !== "better-sqlite3") {
      throw new Error(`Unexpected require: ${request}`);
    }

    return Database;
  }

  requireModule.resolve = (request) => {
    if (request === "better-sqlite3/package.json") {
      return packageJsonPath;
    }

    if (request === "prebuild-install/bin.js") {
      return "/tmp/fake-node-modules/prebuild-install/bin.js";
    }

    if (request === "node-gyp/bin/node-gyp.js") {
      return "/tmp/fake-node-modules/node-gyp/bin/node-gyp.js";
    }

    throw new Error(`Unexpected resolve: ${request}`);
  };

  return {
    requireModule,
    state,
    clearConstructorError() {
      state.constructorError = null;
    },
  };
}

function createEnsureOptions(fakeRequire, execFileSync) {
  return {
    repoRoot: "/repo",
    modules: [
      { name: "better-sqlite3", resolveFrom: "packages/db/package.json" },
    ],
    createRequire: () => fakeRequire,
    execFileSync,
    verifyRepairedNativeModule(name) {
      try {
        verifyNativeModule(name, fakeRequire);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    log: vi.fn(),
  };
}

describe("ensure-native-modules", () => {
  it("does not detect a better-sqlite3 ABI mismatch by requiring the wrapper only", () => {
    const abiError = new Error(
      "The module was compiled against a different NODE_MODULE_VERSION",
    );
    const { requireModule, state } = createBetterSqliteRequire(abiError);

    expect(() => requireModule("better-sqlite3")).not.toThrow();
    expect(state.constructorCalls).toBe(0);
    expect(() => verifyNativeModule("better-sqlite3", requireModule)).toThrow(
      /NODE_MODULE_VERSION/,
    );
    expect(state.constructorCalls).toBe(1);
  });

  it("rechecks better-sqlite3 after installing a prebuilt binary", () => {
    const abiError = new Error(
      "The module was compiled against a different NODE_MODULE_VERSION",
    );
    const fake = createBetterSqliteRequire(abiError);
    const execFileSync = vi.fn(() => {
      fake.clearConstructorError();
    });

    expect(() =>
      ensureNativeModules(
        createEnsureOptions(fake.requireModule, execFileSync),
      ),
    ).not.toThrow();

    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/fake-node-modules/prebuild-install/bin.js"],
      expect.objectContaining({
        cwd: "/tmp/fake-node-modules/better-sqlite3",
        encoding: "utf8",
        env: expect.objectContaining({ npm_config_loglevel: "info" }),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(fake.state.constructorCalls).toBe(2);
  });

  it("detaches a hardlinked native binary before verification", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bb-native-repair-"));
    try {
      const packageJsonPath = join(tempRoot, "better-sqlite3", "package.json");
      const binaryPath = join(
        dirname(packageJsonPath),
        "build",
        "Release",
        "better_sqlite3.node",
      );
      const otherCheckoutBinaryPath = join(tempRoot, "other-checkout.node");
      mkdirSync(dirname(binaryPath), { recursive: true });
      writeFileSync(packageJsonPath, "{}");
      writeFileSync(otherCheckoutBinaryPath, "abi-137");
      linkSync(otherCheckoutBinaryPath, binaryPath);
      expect(statSync(binaryPath).ino).toBe(
        statSync(otherCheckoutBinaryPath).ino,
      );

      const abiError = new Error(
        "The module was compiled against a different NODE_MODULE_VERSION",
      );
      const fake = createBetterSqliteRequire(abiError, packageJsonPath);
      const execFileSync = vi.fn(() => {
        writeFileSync(binaryPath, "abi-127");
        fake.clearConstructorError();
      });
      const options = createEnsureOptions(fake.requireModule, execFileSync);
      options.modules = [
        {
          name: "better-sqlite3",
          resolveFrom: "packages/db/package.json",
          binaryPath: "build/Release/better_sqlite3.node",
        },
      ];

      expect(() => ensureNativeModules(options)).not.toThrow();

      expect(readFileSync(binaryPath, "utf8")).toBe("abi-127");
      expect(readFileSync(otherCheckoutBinaryPath, "utf8")).toBe("abi-137");
      expect(statSync(binaryPath).ino).not.toBe(
        statSync(otherCheckoutBinaryPath).ino,
      );
      expect(options.log).toHaveBeenCalledWith(
        "[ensure-native-modules] Detached hardlinked better-sqlite3 binary before verification",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("detaches a matching native binary without a repair", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "bb-native-verify-"));
    try {
      const packageJsonPath = join(tempRoot, "better-sqlite3", "package.json");
      const binaryPath = join(
        dirname(packageJsonPath),
        "build",
        "Release",
        "better_sqlite3.node",
      );
      const otherCheckoutBinaryPath = join(tempRoot, "other-checkout.node");
      mkdirSync(dirname(binaryPath), { recursive: true });
      writeFileSync(packageJsonPath, "{}");
      writeFileSync(otherCheckoutBinaryPath, "abi-137");
      linkSync(otherCheckoutBinaryPath, binaryPath);

      const fake = createBetterSqliteRequire(null, packageJsonPath);
      const execFileSync = vi.fn();
      const options = createEnsureOptions(fake.requireModule, execFileSync);
      options.modules = [
        {
          name: "better-sqlite3",
          resolveFrom: "packages/db/package.json",
          binaryPath: "build/Release/better_sqlite3.node",
        },
      ];

      expect(() => ensureNativeModules(options)).not.toThrow();

      expect(statSync(binaryPath).ino).not.toBe(
        statSync(otherCheckoutBinaryPath).ino,
      );
      expect(readFileSync(binaryPath, "utf8")).toBe("abi-137");
      expect(readFileSync(otherCheckoutBinaryPath, "utf8")).toBe("abi-137");
      expect(execFileSync).not.toHaveBeenCalled();
      expect(options.log).toHaveBeenCalledWith(
        "[ensure-native-modules] Detached hardlinked better-sqlite3 binary before verification",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("accepts a prebuilt binary that loads after the installer exits non-zero", () => {
    const abiError = new Error(
      "The module was compiled against a different NODE_MODULE_VERSION",
    );
    const fake = createBetterSqliteRequire(abiError);
    const prebuildError = Object.assign(
      new Error("Command failed: prebuild-install"),
      {
        status: 1,
        stderr:
          "prebuild-install info unpack resolved to /tmp/fake-node-modules/better-sqlite3/build/Release/better_sqlite3.node\n",
      },
    );
    const execFileSync = vi.fn((nodePath, args) => {
      if (args[0] === "/tmp/fake-node-modules/prebuild-install/bin.js") {
        fake.clearConstructorError();
        throw prebuildError;
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });
    const options = createEnsureOptions(fake.requireModule, execFileSync);

    expect(() => ensureNativeModules(options)).not.toThrow();

    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(fake.state.constructorCalls).toBe(2);
    expect(options.log).toHaveBeenCalledWith(
      "[ensure-native-modules] Prebuilt better-sqlite3 loaded despite installer failure",
    );
  });

  it("falls back to a source rebuild when prebuild repair fails", () => {
    const missingBindingError = new Error(
      "Could not locate the bindings file. Tried: build/Release/better_sqlite3.node",
    );
    const fake = createBetterSqliteRequire(missingBindingError);
    const prebuildError = Object.assign(
      new Error("Command failed: prebuild-install"),
      {
        status: 1,
        stderr:
          "prebuild-install info install --build-from-source specified, not attempting download.\n",
      },
    );
    const execFileSync = vi.fn((nodePath, args) => {
      if (args[0] === "/tmp/fake-node-modules/prebuild-install/bin.js") {
        throw prebuildError;
      }
      fake.clearConstructorError();
    });
    const options = createEnsureOptions(fake.requireModule, execFileSync);

    expect(() => ensureNativeModules(options)).not.toThrow();

    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      ["/tmp/fake-node-modules/prebuild-install/bin.js"],
      expect.objectContaining({
        cwd: "/tmp/fake-node-modules/better-sqlite3",
        encoding: "utf8",
        env: expect.objectContaining({ npm_config_loglevel: "info" }),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      [
        "/tmp/fake-node-modules/node-gyp/bin/node-gyp.js",
        "rebuild",
        "--release",
      ],
      {
        cwd: "/tmp/fake-node-modules/better-sqlite3",
        stdio: "inherit",
      },
    );
    expect(fake.state.constructorCalls).toBe(3);
    expect(options.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "stderr: prebuild-install info install --build-from-source specified",
      ),
    );
    expect(options.log).toHaveBeenCalledWith(
      expect.stringContaining("Prebuilt better-sqlite3 still failed to load"),
    );
  });

  it("rebuilds from source when an installed prebuild is still ABI-mismatched", () => {
    const abiError = new Error(
      "The module was compiled against a different NODE_MODULE_VERSION",
    );
    const fake = createBetterSqliteRequire(abiError);
    const execFileSync = vi.fn((nodePath, args) => {
      if (args[0] === "/tmp/fake-node-modules/node-gyp/bin/node-gyp.js") {
        fake.clearConstructorError();
      }
    });

    expect(() =>
      ensureNativeModules(
        createEnsureOptions(fake.requireModule, execFileSync),
      ),
    ).not.toThrow();

    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      ["/tmp/fake-node-modules/prebuild-install/bin.js"],
      expect.objectContaining({
        cwd: "/tmp/fake-node-modules/better-sqlite3",
        encoding: "utf8",
        env: expect.objectContaining({ npm_config_loglevel: "info" }),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      [
        "/tmp/fake-node-modules/node-gyp/bin/node-gyp.js",
        "rebuild",
        "--release",
      ],
      {
        cwd: "/tmp/fake-node-modules/better-sqlite3",
        stdio: "inherit",
      },
    );
    expect(fake.state.constructorCalls).toBe(3);
  });

  it("rebuilds when Node reports that the native module did not self-register", () => {
    const registrationError = new Error(
      "Module did not self-register: '/tmp/better_sqlite3.node'",
    );
    const fake = createBetterSqliteRequire(registrationError);
    const execFileSync = vi.fn((nodePath, args) => {
      if (args[0] === "/tmp/fake-node-modules/node-gyp/bin/node-gyp.js") {
        fake.clearConstructorError();
      }
    });

    expect(() =>
      ensureNativeModules(
        createEnsureOptions(fake.requireModule, execFileSync),
      ),
    ).not.toThrow();

    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(fake.state.constructorCalls).toBe(3);
  });

  it("exits non-zero when the post-rebuild instantiation still fails", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { ensureNativeModules } from ${JSON.stringify(scriptUrl)};

          function createRequire() {
            function Database() {
              throw new Error("Wrong native binary NODE_MODULE_VERSION");
            }

            function requireModule(request) {
              if (request !== "better-sqlite3") {
                throw new Error("Unexpected require: " + request);
              }

              return Database;
            }

            requireModule.resolve = () => "/tmp/fake-node-modules/better-sqlite3/package.json";
            return requireModule;
          }

          ensureNativeModules({
            repoRoot: "/repo",
            modules: [{ name: "better-sqlite3", resolveFrom: "packages/db/package.json" }],
            createRequire,
            execFileSync() {},
            verifyRepairedNativeModule() {
              return "Wrong native binary NODE_MODULE_VERSION";
            },
            log() {},
          });
        `,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "better-sqlite3 still failed to load after rebuild",
    );
  });
});
