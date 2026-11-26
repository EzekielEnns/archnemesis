// Lint rules. Existing debt is recorded in eslint-suppressions.json (pnpm lint:bank); the
// pre-push hook (lefthook.yml) refuses a push whose changed files still carry any.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const HOUSE_RULES = [
  {
    selector: "ExportDefaultDeclaration",
    message: "Named exports only: default exports break rename-symbol and unused-code detection.",
  },
  {
    selector:
      "AssignmentExpression[left.type='MemberExpression'][left.object.name=/^(window|globalThis|global|self)$/]",
    message: "Do not write to the global object. Pass the value, or put it in a module.",
  },
];

// The app talks to its backend through src/backend only, so backends can be swapped.
const NO_RAW_FETCH = {
  selector: "CallExpression[callee.name='fetch']",
  message: "No raw fetch in the app: go through the backend (src/backend).",
};

// The environment is read once, in server/config.ts (loadConfig); everything else is handed what
// it needs. (server/env-compat.ts runs before it and copies the old names; test files and test
// support may read it.)
const NO_PROCESS_ENV = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message: "Don't read process.env here: take the setting from the Config (server/config.ts).",
};

export default tseslint.config(
  {
    ignores: [
      "dist",
      "dist-static",
      "node_modules",
      "data",
      "result",
      ".bench",
      ".claude",
      "docs",
      "server/testdata",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-syntax": ["error", ...HOUSE_RULES],
      "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 150, skipBlankLines: true, skipComments: true }],
      complexity: ["error", 25],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/backend/**", "**/*.test.ts"],
    rules: { "no-restricted-syntax": ["error", ...HOUSE_RULES, NO_RAW_FETCH] },
  },
  // The app must not reach into the server, and shared code runs anywhere (no Node, no app).
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/server/**", "**/cli/**"],
              message: "The app doesn't import the server: move the type to shared/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["shared/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/server/**", "**/src/**", "**/cli/**", "node:*"],
              message:
                "shared/ runs in the browser and on the server: no Node, no app, no server imports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "cli/**", "scripts/**", "*.config.ts", "*.config.js"],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "no-console": "off",
      "no-restricted-syntax": "off",
    },
  },
  { files: ["server/**"], rules: { "no-console": "off" } },
  {
    files: ["server/**/*.ts"],
    ignores: ["server/config.ts", "server/env-compat.ts", "server/e2e.ts", "server/testing.ts"],
    rules: { "no-restricted-syntax": ["error", ...HOUSE_RULES, NO_PROCESS_ENV] },
  },
  {
    // cli/ has no house rules (above); it only gets this one.
    files: ["cli/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", NO_PROCESS_ENV] },
  },
  {
    files: ["**/*.test.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
