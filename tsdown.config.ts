import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "es2022",
  dts: false,
  clean: true,
});
