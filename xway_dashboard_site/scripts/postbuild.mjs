import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(process.cwd(), "dist");
const sourcePath = resolve(distDir, "index.react.html");
const targetPath = resolve(distDir, "index.html");

if (!existsSync(sourcePath)) {
  throw new Error(`Cannot create Cloudflare Pages entrypoint: ${sourcePath} does not exist.`);
}

copyFileSync(sourcePath, targetPath);
console.log("Created dist/index.html for Cloudflare Pages.");
