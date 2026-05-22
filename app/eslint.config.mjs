import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-plugin-prettier/recommended";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      ".expo/",
      ".vercel/",
      "dist/",
      "android/",
      "ios/",
      "babel.config.js",
      "metro.config.js",
      "tailwind.config.js",
      "expo-env.d.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  prettier,
  {
    rules: {
      // Downgrade newer react-hooks rules to warn (fix incrementally)
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
      // Relax rules that conflict with the codebase style
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
