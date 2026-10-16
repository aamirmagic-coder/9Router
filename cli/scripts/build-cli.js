#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const cliDir = path.resolve(__dirname, "..");
const appDir = path.resolve(cliDir, "..");
const rootDir = path.resolve(appDir, "..");
const cliAppDir = process.env.NINEROUTER_CLI_APP_DIR || path.join(cliDir, "app");
const buildHomeDir = path.join(cliDir, ".build-home");
const buildDistDirName = ".next-cli-build";
const buildDistDir = path.join(appDir, buildDistDirName);

// Exclude patterns for files/folders we don't want to copy
const EXCLUDE_PATTERNS = [
  "@img",           // Sharp image processing (not needed with unoptimized images)
  "sharp",          // Sharp core lib (not needed with unoptimized images)
  "detect-libc",    // Sharp dependency
  ".env",           // Environment files
  ".env.local",
  ".env.*.local",
  "*.log",          // Log files
  "tmp",            // Temp files
  ".DS_Store",      // macOS files
  ".build-home",    // Build sandbox HOME/APPDATA — holds generated state, not shipped code
];

// Secrets that must never reach a published tarball, wherever they sit in the
// tree. `cli/.build-home/` is a scratch HOME/APPDATA used during the build, and
// the Next.js runner writes a `jwt-secret` into it; the db dir next to it can
// hold account rows. `.gitignore` keeps them out of git but npm packs from the
// filesystem, so the build has to drop them explicitly or they end up in the
// published package.
const SECRET_NAMES = new Set([
  "jwt-secret", "jwt_secret",
  "api-key-secret", "api_key_secret",
  "machine-id-salt", "machine_id_salt",
  ".engine-token.txt",
  "cookies.txt", "creds.json", "config.json",
]);

// Scratch/personal subtrees, matched by directory NAME.
//
// Name matching is safe ONLY for names that third-party code does not use.
// Every entry here is highly specific — a dotfile-like build sandbox, or a
// scratch dir this repo invented. Do NOT add generic names like "cli":
//
//   An earlier version matched "cli" by name to drop the repo's scratch
//   `cli/.build-home` tree, and thereby deleted
//   `node_modules/next/dist/cli/` — which Next.js requires at runtime. Every
//   package built that way crashed on boot with
//   `Cannot find module '../cli/next-test'`. "cli" is an ordinary directory
//   name inside node_modules; it can never be matched globally.
//
// The build sandbox lives at a path that depends on Next.js's tracing root
// (e.g. `.next-cli-build/standalone/<pkg>/cli/.build-home`), so anchoring to a
// fixed path misses it. Matching the specific leaf name hits every location.
const SCRATCH_DIR_NAMES = new Set([
  ".build-home",                    // build sandbox HOME/APPDATA: generated jwt-secret + db rows
  "_muse-re", "_muse-cli-check",    // reverse-engineering scratch (holds muse.ai session cookies)
  "muse-bridge",                    // local Python sidecar (venv + session cookies), not shipped
]);

function isScratchDir(entryPath) {
  return SCRATCH_DIR_NAMES.has(path.basename(entryPath));
}

function isSecretPath(srcPath) {
  return SECRET_NAMES.has(path.basename(srcPath));
}

// ── publish guard ────────────────────────────────────────────────────────
// Scans the directory npm is about to pack and refuses to continue if anything
// secret or scratch is still there.
//
// This deliberately walks the publish directory instead of inspecting an
// already-built .tgz: `npm publish` re-packs from disk, so a tarball produced
// earlier can be stale, and a check against it would pass while the publish
// itself ships something different.
//
// Reports secret FILES by name, and additionally flags scratch paths that are
// still present — but scratch matching is anchored to the publish root, so it
// can never mistake `node_modules/next/dist/cli` for the repo's own scratch
// tree. node_modules is skipped entirely: it is third-party code, and the
// paths we care about never live there.
function collectUnsafeFiles(rootDir) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isScratchDir(p)) {
          found.push(p);
          continue;
        }
        walk(p);
      } else if (entry.isFile() && SECRET_NAMES.has(entry.name)) {
        found.push(p);
      }
    }
  };
  walk(rootDir);
  return found;
}

function assertPublishDirClean(dir) {
  const bad = collectUnsafeFiles(dir);
  if (bad.length) {
    console.error(`\n❌ Refusing to publish — secret files found under ${dir}:`);
    for (const b of bad.slice(0, 20)) console.error(`   ${path.relative(dir, b)}`);
    console.error(`\n   ${bad.length} file. Hapus dari pohon publish sebelum mengulang.\n`);
    process.exit(1);
  }
  console.log("✅ Publish dir clean: no secret files\n");
}

function shouldExclude(name) {
  return EXCLUDE_PATTERNS.some(pattern => {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return regex.test(name);
    }
    return name === pattern;
  });
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`Warning: Source ${src} does not exist`);
    return;
  }
  
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(src, entry.name);
    if (shouldExclude(entry.name)) continue;
    if (entry.isDirectory() && isScratchDir(entryPath)) continue;
    if (entry.isFile() && isSecretPath(entryPath)) continue;

    const srcPath = entryPath;
    const destPath = path.join(dest, entry.name);

    // Skip broken symlinks (common in workspace setups)
    try {
      fs.accessSync(srcPath);
    } catch {
      continue;
    }

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Resolve and copy target (avoid linking outside bundle)
      try {
        const real = fs.realpathSync(srcPath);
        if (fs.statSync(real).isDirectory()) {
          copyRecursive(real, destPath);
        } else {
          fs.copyFileSync(real, destPath);
        }
      } catch {}
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch {}
    }
  }
}

function resolveStandaloneBuild(appDir, buildDistDir) {
  const legacyStandaloneRoot = path.join(appDir, ".next", "standalone");
  const resolvedStandaloneRoot = path.join(buildDistDir, "standalone");
  let standaloneRoot = fs.existsSync(resolvedStandaloneRoot)
    ? resolvedStandaloneRoot
    : legacyStandaloneRoot;

  // Next.js 16 nests standalone output under the project name when
  // NEXT_TRACING_ROOT_MODE=workspace, e.g. standalone/9router/server.js.
  const pkgName = path.basename(appDir);
  const nestedRoot = path.join(standaloneRoot, pkgName);
  if (fs.existsSync(path.join(nestedRoot, "server.js")) && !fs.existsSync(path.join(standaloneRoot, "server.js"))) {
    console.log(`ℹ️  Detected nested standalone output: ${pkgName}/`);
    standaloneRoot = nestedRoot;
  }

  const standaloneApp = fs.existsSync(path.join(standaloneRoot, "server.js"))
    ? standaloneRoot
    : path.join(standaloneRoot, "app");
  if (!fs.existsSync(standaloneApp)) {
    throw new Error(
      "Next.js standalone build not found under .next/standalone; " +
      "expected either .next/standalone/server.js or .next/standalone/app/",
    );
  }

  return { standaloneApp, standaloneRoot };
}

function copyStandaloneBuild(appDir, buildDistDir, cliAppDir) {
  const { standaloneApp, standaloneRoot } = resolveStandaloneBuild(appDir, buildDistDir);
  copyRecursive(standaloneApp, cliAppDir);

  // Older nested-app layout stores traced node_modules at standalone root.
  const standaloneNodeModules = path.join(standaloneRoot, "node_modules");
  if (standaloneApp !== standaloneRoot && fs.existsSync(standaloneNodeModules)) {
    copyRecursive(standaloneNodeModules, path.join(cliAppDir, "node_modules"));
  }
}

function mergeServerArtifacts(buildDistDir, cliAppDir) {
  const serverSrc = path.join(buildDistDir, "server");
  const serverDest = path.join(cliAppDir, buildDistDirName, "server");
  if (!fs.existsSync(serverSrc)) {
    throw new Error(`Complete Next.js server build not found: ${serverSrc}`);
  }
  copyRecursive(serverSrc, serverDest);
}

function assertRequiredApiArtifacts(cliAppDir) {
  const requiredArtifacts = [
    "app/api/v1/chat/completions/route.js",
    "app/api/v1/messages/route.js",
  ];
  const serverDir = path.join(cliAppDir, buildDistDirName, "server");
  const missingArtifacts = requiredArtifacts
    .map((artifact) => path.join(serverDir, artifact))
    .filter((artifact) => !fs.existsSync(artifact));

  if (missingArtifacts.length > 0) {
    throw new Error(
      `Required CLI API route artifact${missingArtifacts.length === 1 ? " is" : "s are"} missing:\n` +
      missingArtifacts.join("\n"),
    );
  }
}

function buildCliPackage() {
  console.log("📦 Building 9Router CLI package with Next.js...\n");

  fs.mkdirSync(buildHomeDir, { recursive: true });
  fs.mkdirSync(path.join(buildHomeDir, "AppData", "Roaming"), { recursive: true });
  fs.mkdirSync(path.join(buildHomeDir, "AppData", "Local"), { recursive: true });

  // Step 0: Sync version from app/cli/package.json to app/package.json
  console.log("0️⃣  Syncing version to app/package.json...");
  const cliPkg = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8"));
  const appPkgPath = path.join(appDir, "package.json");
  const appPkg = JSON.parse(fs.readFileSync(appPkgPath, "utf8"));
  if (appPkg.version !== cliPkg.version) {
    appPkg.version = cliPkg.version;
    fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + "\n");
    console.log(`✅ Version synced: ${cliPkg.version}\n`);
  } else {
    console.log(`✅ Version already synced: ${cliPkg.version}\n`);
  }

  // Step 1: Build app with Next.js (workspace tracing root → traced node_modules in standalone).
  console.log("1️⃣  Building Next.js app...");
  try {
    execSync("npm run build", {
      stdio: "inherit",
      cwd: appDir,
      env: {
        ...process.env,
        HOME: buildHomeDir,
        USERPROFILE: buildHomeDir,
        APPDATA: path.join(buildHomeDir, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(buildHomeDir, "AppData", "Local"),
        NEXT_DIST_DIR: buildDistDirName,
        NEXT_TRACING_ROOT_MODE: "workspace",
      }
    });
    console.log("✅ Next.js build completed\n");
  } catch (error) {
    console.error("❌ Next.js build failed");
    process.exit(1);
  }

  // Step 2: Clean old app/cli/app if exists
  console.log("2️⃣  Cleaning old app/cli/app...");
  if (fs.existsSync(cliAppDir)) {
    fs.rmSync(cliAppDir, { recursive: true, force: true });
  }
  console.log("✅ Cleaned\n");

  // Step 3: Copy Next.js standalone build to app/cli/app.
  // Newer Next.js standalone output writes server.js/package.json plus .next/, src/, and
  // node_modules/ directly under .next/standalone. Older builds may still use a nested app/.
  console.log("3️⃣  Copying Next.js standalone build to app/cli/app...");
  try {
    copyStandaloneBuild(appDir, buildDistDir, cliAppDir);
  } catch (error) {
    console.error("❌ Next.js standalone build not found under .next/standalone");
    console.error("Expected either .next/standalone/server.js or .next/standalone/app/");
    process.exit(1);
  }
  console.log("✅ Copied standalone build\n");

  // Step 3a: Copy custom server (injects real socket IP, strips spoofable XFF).
  const customServerSrc = path.join(appDir, "custom-server.js");
  if (fs.existsSync(customServerSrc)) {
    fs.copyFileSync(customServerSrc, path.join(cliAppDir, "custom-server.js"));
    console.log("✅ Copied custom-server.js\n");
  } else {
    console.error("❌ custom-server.js not found — without it no request can be proven local,");
    console.error("   so the packaged CLI would demand an API key for its own dashboard and /v1.");
    process.exit(1);
  }

  // Step 3b: Ensure sql.js (pure JS fallback) bundled in app/cli/app/node_modules.
  // Strip better-sqlite3 (native) — it lives in ~/.9router/runtime to avoid
  // Windows EBUSY during global CLI updates. node:sqlite (Node ≥22.5) is also
  // available as a no-install middle tier.
  console.log("3️⃣ b Configuring SQLite drivers...");
  function ensureModuleInBundle(pkg) {
    const dest = path.join(cliAppDir, "node_modules", pkg);
    if (fs.existsSync(dest)) {
      console.log(`✅ ${pkg} already bundled`);
      return;
    }
    const candidates = [
      path.join(appDir, "node_modules", pkg),
      path.join(rootDir, "node_modules", pkg),
    ];
    const src = candidates.find((p) => fs.existsSync(p));
    if (!src) {
      console.warn(`⚠️  ${pkg} not found locally — bundle will rely on node:sqlite or runtime install`);
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyRecursive(src, dest);
    console.log(`✅ Bundled ${pkg}`);
  }
  ensureModuleInBundle("sql.js");
  // `open` is external (see serverExternalPackages in next.config.mjs), so it must exist in
  // the bundle's node_modules or every importer throws MODULE_NOT_FOUND at runtime. Output
  // tracing normally copies it; this is the same belt-and-braces guard used for sql.js.
  ensureModuleInBundle("open");
  const betterDir = path.join(cliAppDir, "node_modules", "better-sqlite3");
  if (fs.existsSync(betterDir)) {
    fs.rmSync(betterDir, { recursive: true, force: true });
    console.log("✅ Stripped better-sqlite3 (lives in ~/.9router/runtime)");
  }
  console.log("");

  // Step 4: Copy static files
  console.log("4️⃣  Copying static files...");
  const staticSrc = path.join(appDir, ".next", "static");
  const staticSrcResolved = path.join(buildDistDir, "static");
  const staticDest = path.join(cliAppDir, buildDistDirName, "static");
  if (fs.existsSync(staticSrcResolved) || fs.existsSync(staticSrc)) {
    copyRecursive(fs.existsSync(staticSrcResolved) ? staticSrcResolved : staticSrc, staticDest);
    console.log("✅ Copied static files\n");
  } else {
    console.log("⏭️  No static files found\n");
  }

  // Step 5: Copy public folder if exists
  console.log("5️⃣  Copying public folder...");
  const publicSrc = path.join(appDir, "public");
  const publicDest = path.join(cliAppDir, "public");
  if (fs.existsSync(publicSrc)) {
    copyRecursive(publicSrc, publicDest);
    console.log("✅ Copied public folder\n");
  } else {
    console.log("⏭️  No public folder found\n");
  }

  // Step 6: Copy vendor-chunks (required for production)
  console.log("6️⃣  Copying vendor-chunks...");
  const vendorChunksSrc = path.join(appDir, ".next", "server", "vendor-chunks");
  const vendorChunksSrcResolved = path.join(buildDistDir, "server", "vendor-chunks");
  const vendorChunksDest = path.join(cliAppDir, buildDistDirName, "server", "vendor-chunks");
  if (fs.existsSync(vendorChunksSrcResolved) || fs.existsSync(vendorChunksSrc)) {
    copyRecursive(fs.existsSync(vendorChunksSrcResolved) ? vendorChunksSrcResolved : vendorChunksSrc, vendorChunksDest);
    console.log("✅ Copied vendor-chunks\n");
  } else {
    console.log("⏭️  No vendor-chunks found\n");
  }

  // Step 6b: Merge the complete generated server tree. Next.js standalone output
  // is trace-pruned and can omit route modules or chunks loaded dynamically.
  console.log("6️⃣ b Copying complete server artifacts...");
  mergeServerArtifacts(buildDistDir, cliAppDir);
  assertRequiredApiArtifacts(cliAppDir);
  console.log("✅ Copied complete server artifacts\n");

  // Step 7: Copy MITM server files (not bundled by Next.js standalone)
  console.log("7️⃣  Copying MITM server files...");
  const mitmSrc = path.join(appDir, "src", "mitm");
  const mitmDest = path.join(cliAppDir, "src", "mitm");
  if (fs.existsSync(mitmSrc)) {
    copyRecursive(mitmSrc, mitmDest);
    console.log("✅ Copied MITM files\n");
  } else {
    console.log("⏭️  No MITM files found\n");
  }

  // Step 7b: Copy standalone updater (headless Node process for install progress)
  console.log("7️⃣ b Copying updater files...");
  const updaterSrc = path.join(appDir, "src", "lib", "updater");
  const updaterDest = path.join(cliAppDir, "src", "lib", "updater");
  if (fs.existsSync(updaterSrc)) {
    copyRecursive(updaterSrc, updaterDest);
    console.log("✅ Copied updater files\n");
  } else {
    console.log("⏭️  No updater files found\n");
  }

  // Step 8: Build MITM server (config driven - see app/cli/scripts/buildMitm.js)
  console.log("8️⃣  Building MITM server...");
  try {
    execSync("node scripts/buildMitm.js", { stdio: "inherit", cwd: cliDir });
    console.log("✅ MITM server build completed\n");
  } catch (error) {
    console.error("❌ MITM build failed");
    process.exit(1);
  }

  console.log("✨ CLI package build completed!");
  console.log(`📁 Output: ${cliAppDir}`);

  try {
    const { execSync: exec } = require("child_process");
    const size = exec(`du -sh "${cliAppDir}"`, { encoding: "utf8" }).trim();
    console.log(`📊 Package size: ${size.split("\t")[0]}`);
  } catch (e) {
    // Silent fail on size check
  }
}

module.exports = {
  assertRequiredApiArtifacts,
  assertPublishDirClean,
  copyStandaloneBuild,
  mergeServerArtifacts,
};

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === "--assert-clean") {
    // Called from prepublishOnly AFTER the build regenerated cli/app, so the
    // check and the publish see exactly the same tree.
    assertPublishDirClean(process.argv[3] || path.join(__dirname, "..", "app"));
  } else {
    buildCliPackage();
  }
}
