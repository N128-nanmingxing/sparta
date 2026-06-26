import { cp, mkdir, rm } from "node:fs/promises";

const outDir = new URL("../dist/", import.meta.url);
const root = new URL("../", import.meta.url);

const entries = [
  "index.html",
  "admin.html",
  "admin",
  "src",
  "functions",
  "_routes.json",
  "_redirects",
  "wrangler.toml",
];

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });

for (const entry of entries) {
  await cp(new URL(entry, root), new URL(entry, outDir), {
    force: true,
    recursive: true,
  });
}
