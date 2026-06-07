import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        // One React at runtime even though @kodus/ui resolves deps from its
        // own node_modules (source alias below).
        dedupe: ["react", "react-dom"],
        alias: {
            // Consume the DS from source: instant HMR across the package,
            // no publish/build step during the migration.
            "@kodus/ui": path.resolve(
                __dirname,
                "../../packages/kodus-ui/src",
            ),
            "@": path.resolve(__dirname, "src"),
        },
    },
    server: {
        port: 5181,
        proxy: {
            // Same-origin in prod (path-routed). In dev, proxy auth/session
            // and API calls to the Next app so the Auth.js cookie works.
            "/api": {
                target: "http://localhost:3000",
                changeOrigin: false,
            },
        },
    },
});
