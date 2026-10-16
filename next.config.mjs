import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));
// CLI bundling needs workspace root so tracing includes hoisted node_modules (slim ~50MB).
// Docker / default uses projectRoot so server.js lands at /app/server.js (not nested).
const tracingRoot = process.env.NEXT_TRACING_ROOT_MODE === "workspace"
  ? join(projectRoot, "..")
  : projectRoot;
const proxyClientMaxBodySize = process.env.NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE || "128mb";

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",

  /**
   * Halaman dashboard TIDAK boleh di-cache lama.
   *
   * Halaman-halaman ini adalah client component, dan tanpa arahan eksplisit
   * Next.js memperlakukannya sebagai statis: `/dashboard/usage` terukur
   * mengirim `Cache-Control: s-maxage=31536000` (1 TAHUN) dengan
   * `x-nextjs-cache: HIT`.
   *
   * Akibatnya HTML basi terus disajikan, dan HTML itu menunjuk ke nama chunk
   * JS versi LAMA. Browser lalu memuat bundle lama meski chunk baru sudah ada
   * di server — sehingga perbaikan (mis. fix pergantian period di Usage)
   * tidak pernah sampai ke pengguna sampai mereka hard-reload.
   *
   * `no-store` pada dokumen HTML; chunk ber-hash di bawah /_next/static tetap
   * boleh di-cache selamanya karena namanya berubah saat isinya berubah.
   */
  async headers() {
    return [
      {
        source: "/dashboard/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
    ];
  },
  // `open` must stay external. It derives its own directory from `import.meta.url`, and
  // webpack replaces that with the absolute path of the BUILD machine as a string literal.
  // A release built on macOS therefore ships `file:///Users/.../open/index.js`, which
  // `fileURLToPath` rejects on Windows ("File URL path must be absolute" — no drive
  // letter). That throw happens at module scope, so every consumer of `open` dies on
  // import — including xAI/Grok token refresh, which loads the OAuth service that imports
  // it. Keeping it external preserves the real `import.meta.url` at runtime.
  // @aws-sdk/credential-providers must stay external for the same class of reason: it reads
  // ~/.aws/config and the SSO token cache from disk at runtime and resolves its credential
  // plugins by dynamic require, neither of which survives bundling.
  serverExternalPackages: ["better-sqlite3", "sql.js", "node:sqlite", "bun:sqlite", "open", "@aws-sdk/credential-providers"],
  turbopack: {
    root: tracingRoot
  },
  outputFileTracingRoot: tracingRoot,
  outputFileTracingExcludes: {
    "*": ["./gitbook/**/*"]
  },
  images: {
    unoptimized: true
  },
  env: {},
  experimental: {
    // #1529/#1572: LLM clients can send long context or base64 image payloads through /v1 rewrites.
    proxyClientMaxBodySize,
    // Cache fetch responses across HMR refreshes for faster dev reloads.
    serverComponentsHmrCache: true,
    // Tree-shake heavy barrel imports to cut compile + bundle size
    // @xyflow/react dihapus 26 Sep 2026: satu-satunya pemakainya adalah
    // ProviderTopology, yang ikut dihapus bersama komponen Usage lama.
    // Membiarkannya di sini bukan error, tapi ia menyuruh bundler
    // mengoptimalkan paket yang tidak pernah diimpor.
    optimizePackageImports: ["@dnd-kit/core", "@dnd-kit/sortable", "material-symbols", "marked"],
  },
  webpack: (config, { isServer }) => {
    // Ignore fs/path modules in browser bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }
    // Exclude non-source dirs from watcher to reduce inotify load
    config.watchOptions = {
      ...config.watchOptions,
      aggregateTimeout: 300,
      ignored: /[\\/](node_modules|\.git|logs|\.next|\.next-cli-build|gitbook|cli|open-sse\.old|tests|docs)[\\/]/,
    };
    return config;
  },
  async rewrites() {
    return [
      {
        source: "/v1/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1/v1",
        destination: "/api/v1"
      },
      {
        source: "/codex/:path*",
        destination: "/api/v1/responses"
      },
      {
        source: "/responses",
        destination: "/api/v1/responses"
      },
      {
        source: "/systemone",
        destination: "/api/v1/systemone"
      },
      {
        source: "/v1beta/:path*",
        destination: "/api/v1beta/:path*"
      },
      {
        source: "/v1beta",
        destination: "/api/v1beta"
      },
      {
        source: "/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1",
        destination: "/api/v1"
      }
    ];
  }
};

export default nextConfig;
