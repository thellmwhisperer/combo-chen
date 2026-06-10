import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "src/cli/main.ts" },
  format: "esm",
  outDir: "dist",
  clean: true,
  dts: false,
});
