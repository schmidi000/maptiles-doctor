import js from "@eslint/js";

export default [
  {
    ignores: [
      "**/*.ts",
      "**/dist/**",
      "**/action-dist/**",
      "**/extension-dist/**",
      "fixtures/generated/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "package-lock.json"
    ]
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.ts"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        AbortController: "readonly",
        ArrayBuffer: "readonly",
        Buffer: "readonly",
        Headers: "readonly",
        URL: "readonly",
        console: "readonly",
        process: "readonly",
        fetch: "readonly"
      }
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],
      "no-undef": "off"
    }
  }
];
