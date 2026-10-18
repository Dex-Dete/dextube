import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * ESLint flat config.
 *
 * Next.js 16 removed `next lint`; the recommended setup is the ESLint CLI with
 * `eslint-config-next`. See `node_modules/next/dist/docs/` → “ESLint” (App
 * Router) for the upstream guidance this file follows.
 *
 * `npm run lint` runs this config over the whole tree.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Underscore-prefixed identifiers are the project's explicit "unused on
      // purpose" marker for route-handler parameters and destructuring holes.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // Every image is served through the authorization-checked `/api/media/*`
      // route (medias are private-or-public per request). `next/image` cannot be
      // used: its optimizer fetches the source itself, which would bypass the
      // per-request authorization that protects private and unlisted media.
      "@next/next/no-img-element": "off",
    },
  },
  globalIgnores([
    // Default ignores of eslint-config-next.
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated / runtime artifacts that are not source.
    "node_modules/**",
    "storage/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
