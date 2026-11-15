import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Forward API calls to the Fastify server during development. The regex
    // keeps source modules such as /api.ts from being proxied too.
    proxy: { "^/api/": "http://localhost:3000" },
  },
});
