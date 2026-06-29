import { cp, mkdir, rm } from "node:fs/promises";

const outDir = new URL("../dist/", import.meta.url);
const root = new URL("../", import.meta.url);

const entries = [
  "index.html",
  "admin.html",
  "admin",
  "_routes.json",
  "_redirects",
];

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });
await mkdir(new URL("assets/", outDir), { recursive: true });

for (const entry of entries) {
  await cp(new URL(entry, root), new URL(entry, outDir), {
    force: true,
    recursive: true,
  });
}

await cp(new URL("src/styles.css", root), new URL("assets/styles.css", outDir), {
  force: true,
});
await cp(new URL("src/app.js", root), new URL("assets/app.js", outDir), {
  force: true,
});
await cp(new URL("src/admin.js", root), new URL("assets/admin.js", outDir), {
  force: true,
});
