import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// eslint-config-next@15.5 ships only a legacy (eslintrc-style) config, so we
// bridge it into the flat config system via FlatCompat. `next/core-web-vitals`
// pulls in the Next.js recommended + web-vitals rules; `next/typescript` adds
// the TypeScript recommended rules.
const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "out/**", "build/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default eslintConfig;
