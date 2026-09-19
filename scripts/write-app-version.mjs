import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildId =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  process.env.VITE_APP_BUILD_ID ||
  `local-${Date.now().toString(36)}`;

const payload = {
  buildId,
  builtAt: new Date().toISOString(),
};

mkdirSync(resolve(root, "public"), { recursive: true });
writeFileSync(
  resolve(root, "public/app-version.json"),
  `${JSON.stringify(payload, null, 2)}\n`,
  "utf8"
);

// Also stamp dist after build when this script runs postbuild.
try {
  mkdirSync(resolve(root, "dist"), { recursive: true });
  writeFileSync(
    resolve(root, "dist/app-version.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
} catch {
  // dist may not exist on prebuild — that's fine.
}

process.env.VITE_APP_BUILD_ID = buildId;
console.log(`app-version: ${buildId}`);
