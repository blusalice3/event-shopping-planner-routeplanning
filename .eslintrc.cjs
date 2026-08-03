module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ["@typescript-eslint", "react-hooks"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier",
  ],
  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
        varsIgnorePattern: "^_",
      },
    ],
    "no-constant-condition": ["error", { checkLoops: false }],
    "no-useless-escape": "warn",
    "prefer-const": "warn",
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
  },
  ignorePatterns: [
    "dist/",
    "node_modules/",
    "src/**/*_backup.ts",
    "src/**/*_backup.tsx",
    "src/**/*.backup.ts",
    "src/**/*.backup.tsx",
  ],
  overrides: [
    {
      files: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      env: {
        node: true,
      },
    },
    {
      files: ["api/**/*.mjs", "scripts/**/*.mjs", "vite.config.ts"],
      env: {
        browser: false,
        node: true,
      },
    },
  ],
};
