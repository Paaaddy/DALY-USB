import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
    {
        ignores: ["build/", "node_modules/", "admin/", "reference.py"],
    },
    eslint.configs.recommended,
    {
        files: ["**/*.ts"],
        extends: [...tseslint.configs.recommendedTypeChecked],
        languageOptions: {
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/no-misused-promises": "error",
            "@typescript-eslint/require-await": "warn",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-namespace": "off",
        },
    },
    {
        files: ["**/*.test.ts"],
        rules: {
            "@typescript-eslint/no-unused-expressions": "off",
        },
    },
    {
        files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
);
