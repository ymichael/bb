import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });
import { buildPluginApp, resolvePluginBuildToolchain } from "@bb/plugin-build";
function testToolchain() {
  return resolvePluginBuildToolchain(join(tmpdir(), "bb-toolchain-unused"));
}

const SIMPLE_NOTES_DIR = fileURLToPath(
  new URL("../../../../plugins/docs", import.meta.url),
);

interface SlotRegistration {
  id: string;
  title?: string;
  icon?: string;
  path?: string;
  extensions?: string[];
  component: unknown;
}

describe("Docs official plugin frontend bundle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-simple-notes-bundle-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    delete (globalThis as { __bbPluginRuntime?: unknown }).__bbPluginRuntime;
    delete (globalThis as { document?: unknown }).document;
  });

  it("registers the Docs nav, directive, thread-panel, and file-opener surfaces", async () => {
    const pluginDir = join(root, "simple-notes");
    await cp(SIMPLE_NOTES_DIR, pluginDir, {
      recursive: true,
      filter: (source) => {
        const name = basename(source);
        return name !== "dist" && name !== "node_modules";
      },
    });
    await symlink(
      join(SIMPLE_NOTES_DIR, "node_modules"),
      join(pluginDir, "node_modules"),
      "dir",
    );
    const { jsPath } = await buildPluginApp(
      pluginDir,
      "0.9.0-test",
      await testToolchain(),
    );

    const registered: Record<string, SlotRegistration[]> = {
      homepageSection: [],
      navPanel: [],
      threadPanelAction: [],
      sidebarFooterAction: [],
      fileOpener: [],
      messageDirective: [],
    };
    const componentStub: unknown = new Proxy(function stub() {}, {
      get: (target, prop) =>
        prop === "prototype"
          ? Reflect.get(target, prop)
          : (componentStub as object),
      set: () => true,
    });
    (globalThis as { __bbPluginRuntime?: unknown }).__bbPluginRuntime = {
      react: {
        forwardRef: (render: unknown) => render,
        createContext: () => ({}),
        memo: (component: unknown) => component,
      },
      reactDom: componentStub,
      reactDomClient: componentStub,
      jsxRuntime: { jsx: () => ({}), jsxs: () => ({}), Fragment: {} },
      pluginSdkApp: {
        definePluginApp: (setup: unknown) => ({ __bbPluginApp: true, setup }),
      },
      sonner: componentStub,
      vaul: componentStub,
      pierreDiffs: componentStub,
      pierreDiffsReact: componentStub,
      radixContextMenu: componentStub,
      radixDialog: componentStub,
      radixSelect: componentStub,
      clsx: componentStub,
      tailwindMerge: componentStub,
      classVarianceAuthority: componentStub,
      sharedUiIcon: componentStub,
    };
    (globalThis as { document?: unknown }).document = {
      createElement: () => ({ innerHTML: "", textContent: "", style: {} }),
      documentElement: { style: {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const mod = (await import(
      /* @vite-ignore */ pathToFileURL(jsPath).href
    )) as {
      default: {
        __bbPluginApp: boolean;
        setup: (app: {
          slots: Record<string, (registration: SlotRegistration) => void>;
        }) => void;
      };
    };
    expect(mod.default.__bbPluginApp).toBe(true);
    mod.default.setup({
      slots: {
        homepageSection: (r) => registered.homepageSection.push(r),
        navPanel: (r) => registered.navPanel.push(r),
        threadPanelAction: (r) => registered.threadPanelAction.push(r),
        sidebarFooterAction: (r) => registered.sidebarFooterAction.push(r),
        fileOpener: (r) => registered.fileOpener.push(r),
        messageDirective: (r) => registered.messageDirective.push(r),
      },
    });

    expect(registered.navPanel).toHaveLength(1);
    expect(registered.navPanel[0]).toMatchObject({
      id: "docs",
      title: "Docs",
      path: "docs",
    });
    expect(typeof registered.navPanel[0]?.component).toBe("function");

    expect(registered.homepageSection).toHaveLength(0);
    expect(registered.threadPanelAction[0]).toMatchObject({
      id: "document",
      title: "Document",
    });
    expect(typeof registered.threadPanelAction[0]?.component).toBe("function");
    expect(registered.messageDirective[0]).toMatchObject({ id: "docs" });
    expect(typeof registered.messageDirective[0]?.component).toBe("function");
    expect(registered.sidebarFooterAction).toHaveLength(0);
    expect(registered.fileOpener[0]).toMatchObject({
      id: "docs",
      title: "Markdown",
      extensions: ["md", "mdx", "markdown"],
    });
    expect(typeof registered.fileOpener[0]?.component).toBe("function");
  });
});
