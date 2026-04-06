import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

const noBlockingChildProcessRules = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        {
          name: "node:child_process",
          importNames: ["spawnSync", "execSync", "execFileSync"],
          message: "Use async child_process APIs instead of blocking sync variants.",
        },
        {
          name: "child_process",
          importNames: ["spawnSync", "execSync", "execFileSync"],
          message: "Use async child_process APIs instead of blocking sync variants.",
        },
      ],
    },
  ],
  "no-restricted-syntax": [
    "error",
    {
      selector:
        "CallExpression[callee.name='spawnSync'], CallExpression[callee.name='execSync'], CallExpression[callee.name='execFileSync']",
      message: "Use async child_process APIs instead of blocking sync variants.",
    },
  ],
};

// The server must not access workspace filesystems directly — all workspace
// interaction goes through daemon commands. This rule enforces the boundary so
// it holds when the daemon runs on a remote host (Phase 8 sandbox).
const serverNoWorkspaceAccessRules = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        {
          name: "@bb/workspace",
          message:
            "Server must not access workspaces directly. Use daemon commands instead.",
        },
        {
          name: "@bb/host-workspace",
          message:
            "Server must not access workspaces directly. Use daemon commands instead.",
        },
        {
          name: "node:fs",
          message:
            "Server must not use node:fs. Use daemon commands for workspace access. (attachments.ts is the only exception — it manages server-local storage.)",
        },
        {
          name: "node:fs/promises",
          message:
            "Server must not use node:fs/promises. Use daemon commands for workspace access. (attachments.ts is the only exception — it manages server-local storage.)",
        },
      ],
    },
  ],
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "packages/core/src/generated/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    ignores: [
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/scripts/**",
      "packages/core/src/generated/**",
    ],
    rules: noBlockingChildProcessRules,
  },
  {
    files: ["apps/server/src/**/*.ts"],
    ignores: [
      "**/*.test.ts",
      "**/__tests__/**",
    ],
    rules: serverNoWorkspaceAccessRules,
  },
];
