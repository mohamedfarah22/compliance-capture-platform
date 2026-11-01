import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The gold rules live outside app/ so the Deno edge functions can import the same file.
const goldRules = fileURLToPath(new URL("../supabase/functions/_shared/goldRules.js", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: { "@gold-rules": goldRules },
    },
    server: {
        // Let the dev server serve goldRules.js from outside app/.
        fs: { allow: [repoRoot] },
    },
    test: {
        environment: "jsdom",
        globals: false,
        setupFiles: "./src/test/setup.js",
    },
});
