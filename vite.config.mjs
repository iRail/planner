import { defineConfig } from "vite";

export default defineConfig({
  root: "playground",
  base: "./",
  build: {
    outDir: "../dist/playground",
    emptyOutDir: true,
    rollupOptions: {
      // Two pages: the playground/docs and the iRail API comparison.
      input: {
        main: "playground/index.html",
        irail: "playground/irail.html",
      },
    },
  },
  worker: { format: "es" },
});
