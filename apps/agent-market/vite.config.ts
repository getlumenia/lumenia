import { defineConfig } from "vitest/config";

// One file for both tools: `vitest run` reads `test`, `vite build` reads `build` and `ssr`.
export default defineConfig({
  build: {
    // A Node bundle, dist/worker.js. The worker's one workspace import, @lumenia/near, is
    // TypeScript source behind the workspace link (apps/web runs it through tsx; plain Node
    // cannot), so it is inlined here; near-api-js, zod and node:* stay external and resolve
    // from this package's node_modules at run time.
    ssr: "src/worker.ts",
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: "worker.js", format: "es" } },
  },
  ssr: { target: "node", noExternal: ["@lumenia/near"] },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
