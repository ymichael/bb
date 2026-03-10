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

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "packages/agent-core/src/generated/**",
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
      "packages/agent-core/src/generated/**",
    ],
    rules: noBlockingChildProcessRules,
  },
];
