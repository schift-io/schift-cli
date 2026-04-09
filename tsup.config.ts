import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string };

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  define: {
    __SCHIFT_VERSION__: JSON.stringify(packageJson.version),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
