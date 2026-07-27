import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import typescriptEslint from "typescript-eslint";

const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    ".wrangler/**",
    "dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  js.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  nextPlugin.configs["core-web-vitals"],
  reactHooks.configs.flat.recommended,
]);

export default eslintConfig;
