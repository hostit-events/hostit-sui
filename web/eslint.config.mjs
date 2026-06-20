// eslint-config-next@16 ships NATIVE ESLint flat config (no more eslintrc/
// FlatCompat bridge — wrapping it via FlatCompat now throws a circular-structure
// error). Import the flat configs directly and spread them:
//   core-web-vitals → Next.js recommended + web-vitals rules
//   typescript      → the TypeScript recommended rules
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "out/**", "build/**", "next-env.d.ts"],
  },
  ...coreWebVitals,
  ...typescript,
  {
    // eslint-config-next@16 bumped eslint-plugin-react-hooks to v6, which enables
    // the React COMPILER rule tier as errors. These flag pre-existing, intentional
    // patterns across the app, and their "fixes" are net regressions:
    //   • set-state-in-effect → our SSR-safe localStorage hydration (setX(load())
    //     in a mount effect); lazy-init instead would cause hydration mismatches.
    //   • purity (Date.now() at render) → time-based UI (purchase-window open,
    //     countdowns) that intentionally recomputes each render.
    //   • preserve-manual-memoization → useMemo the compiler can't prove but which
    //     is correct; refs / static-components → same class of compiler readiness.
    // Adopting the React Compiler + satisfying these is its own follow-up, not part
    // of this framework bump. Downgrade to WARN so the classic rules-of-hooks /
    // exhaustive-deps stay ERRORS and CI stays green while the signal stays visible.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/static-components": "warn",
    },
  },
];

export default eslintConfig;
