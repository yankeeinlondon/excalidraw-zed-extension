import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Production build: just React + the output paths.
// Dev server: adds a mock API (GET/POST /config /data, GET /events,
// POST /editor-closed) so you can run `vite dev` without the Rust binary.
// The /data handlers implement the same conditional-write contract as the
// Rust server (ETag on GET, If-Match with 428/412/200 on POST) via the
// shared, unit-tested primitives in src/mock-server-core.ts.
//
// In dev, open any excalidraw file by passing a ?file= query param:
//   http://localhost:5173?file=/absolute/path/to/diagram.excalidraw
// Omit ?file= to fall back to DEV_FILE env var or preview-binary/test.excalidraw.
export default defineConfig(({ command }) => {
  const isDev = command === "serve";

  return {
    plugins: [
      isDev ? mockApiPlugin() : null,
      react(),
      isDev ? null : copyDrawingFontsPlugin(),
    ].filter(Boolean),
    base: "/assets/",
    build: {
      outDir: "../assets",
      emptyOutDir: true,
      // The Excalidraw editor is a single ~1.3 MB chunk, and its on-demand
      // mermaid-diagram support (cytoscape + katex) is a separate ~1.8 MB lazy
      // chunk. This bundle is embedded in the preview binary and served over
      // loopback from local disk, so there is no network/CDN cost to code-split
      // for — splitting further would just add local requests for no benefit.
      // Raise the warning ceiling above those real footprints (default 500 kB),
      // keeping enough headroom that a genuine size regression (e.g. an accidental
      // dep blowing the bundle up) still warns.
      chunkSizeWarningLimit: 2000,
    },
  };
});

// ── Production-only: copy Excalidraw's drawing fonts into the embedded assets ──
//
// Excalidraw's runtime font loader fetches the seven hand-drawn font families
// (Excalifont, Nunito, ComicShanns, Lilita, Cascadia, Virgil, Xiaolai) from
// `${EXCALIDRAW_ASSET_PATH}fonts/<Family>/<hashed>.woff2` at runtime. The bundle
// ships these as `node_modules/@excalidraw/excalidraw/dist/prod/fonts/`; Vite's
// own asset graph never emits them, so without this copy every drawing-font fetch
// 404s and exported SVGs reference fonts that aren't there.
//
// With `EXCALIDRAW_ASSET_PATH = "/assets/"`, the runtime requests
// `/assets/fonts/<Family>/…woff2`, which the Rust server resolves to the embedded
// `assets/fonts/…` path (rust-embed `folder = "assets/"`). So the destination is
// `<outDir>/fonts` = `preview-binary/assets/fonts`.
//
// Implemented with `fs.cpSync` in `closeBundle` (no extra dependency, guaranteed
// to work on Vite 8) rather than vite-plugin-static-copy.
function copyDrawingFontsPlugin() {
  return {
    name: "copy-drawing-fonts",
    closeBundle() {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const srcDir = path.resolve(
        __dirname,
        "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
      );
      const destDir = path.resolve(__dirname, "../assets/fonts");
      // A release build that embeds the assets must ship the drawing fonts, or
      // every runtime font fetch 404s and exported SVGs reference missing fonts
      // (the original bug). Fail the build loudly rather than emit a broken bundle.
      if (!fs.existsSync(srcDir)) {
        throw new Error(
          `[copy-drawing-fonts] font source not found: ${srcDir}\n` +
            `Run \`npm install\` in preview-binary/webview-src so @excalidraw/excalidraw ` +
            `ships its prod fonts before building the release bundle.`,
        );
      }
      fs.cpSync(srcDir, destDir, { recursive: true });
      const families = fs
        .readdirSync(destDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      if (families.length === 0) {
        throw new Error(
          `[copy-drawing-fonts] no font families copied into ${destDir}; ` +
            `the font source at ${srcDir} appears empty. Reinstall @excalidraw/excalidraw.`,
        );
      }
      console.info(
        `[copy-drawing-fonts] copied ${families.length} font families → assets/fonts/ (${families.join(", ")})`,
      );
    },
  };
}

// ── Dev-only mock API ─────────────────────────────────────────────────────────

function mockApiPlugin() {
  // Lazy imports — only evaluated when the dev server starts, never during build.
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const url = require("url") as typeof import("url");
  const { execSync } = require("child_process") as typeof import("child_process");
  // Shared with the unit tests: the revision/If-Match primitives mirroring the
  // Rust server's conditional-write contract. Typed inline (rather than
  // `typeof import(...)`) so this composite project stays self-contained.
  const {
    computeMockRevision,
    mockIfMatchAllows,
    MOCK_ABSENT_REVISION,
  } = require("./src/mock-server-core") as {
    computeMockRevision: (bytes: Uint8Array) => string;
    mockIfMatchAllows: (
      header: string | undefined | null,
      currentRevision: string,
    ) => boolean;
    MOCK_ABSENT_REVISION: string;
  };

  // Default file when no ?file= param is given.
  const DEFAULT_FILE: string = process.env.DEV_FILE
    ? path.resolve(process.env.DEV_FILE as string)
    : path.resolve(__dirname, "../test.excalidraw");

  // Create a minimal blank diagram if the default file doesn't exist.
  if (!fs.existsSync(DEFAULT_FILE)) {
    fs.writeFileSync(
      DEFAULT_FILE,
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "excalidraw-zed-preview",
        elements: [],
        appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
        files: {},
      }),
    );
    console.info(`[mock-api] Created empty test file at ${DEFAULT_FILE}`);
  }

  function resolveFile(reqUrl: string | undefined): string {
    const parsed = url.parse(reqUrl ?? "", true);
    const fileQ = parsed.query["file"];
    if (typeof fileQ === "string" && fileQ) {
      return path.resolve(fileQ);
    }
    return DEFAULT_FILE;
  }

  function contentTypeFor(filePath: string): string {
    const name = path.basename(filePath);
    if (name.endsWith(".excalidraw.svg")) return "image/svg+xml";
    if (name.endsWith(".excalidraw.png")) return "image/png";
    return "application/json";
  }

  function detectSystemTheme(): "dark" | "light" {
    const env = process.env.THEME;
    if (env === "dark" || env === "light") return env;
    try {
      const scheme = execSync(
        "gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null",
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      if (scheme.includes("dark")) return "dark";
    } catch { /* not GNOME */ }
    try {
      const style = execSync("defaults read -g AppleInterfaceStyle 2>/dev/null", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (style === "Dark") return "dark";
    } catch { /* not macOS */ }
    return "light";
  }

  const systemTheme = detectSystemTheme();

  // Per-file SSE client sets: Map<absoluteFilePath, Set<ServerResponse>>
  const sseClientMap = new Map<string, Set<import("http").ServerResponse>>();

  function getSseClients(filePath: string): Set<import("http").ServerResponse> {
    if (!sseClientMap.has(filePath)) sseClientMap.set(filePath, new Set());
    return sseClientMap.get(filePath)!;
  }

  function broadcastReload(filePath: string) {
    broadcastSse(filePath, "reload");
  }

  /** Sends one SSE frame to every client watching `filePath`. */
  function broadcastSse(filePath: string, event: string) {
    const clients = sseClientMap.get(filePath);
    if (!clients) return;
    for (const res of clients) {
      try { res.write(`data: ${event}\n\n`); }
      catch { clients.delete(res); }
    }
  }

  // Watch multiple files — one fs.watch per unique file path that gets requested.
  const watched = new Set<string>();
  function ensureWatched(filePath: string) {
    if (watched.has(filePath)) return;
    watched.add(filePath);
    let debounce: ReturnType<typeof setTimeout> | null = null;
    try {
      fs.watch(filePath, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => broadcastReload(filePath), 80);
      });
    } catch (e) {
      console.warn(`[mock-api] Could not watch ${filePath}: ${e}`);
    }
  }

  // Start watching the default file immediately.
  ensureWatched(DEFAULT_FILE);

  return {
    name: "mock-api",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use("/config", (req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
        const filePath = resolveFile(req.url);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          contentType: contentTypeFor(filePath),
          name: path.basename(filePath),
          theme: systemTheme,
          autoSave: false,
        }));
      });

      server.middlewares.use("/data", (req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
        const filePath = resolveFile(req.url);
        if (req.method === "POST") {
          const ifMatch = req.headers["if-match"];
          const ifMatchHeader = Array.isArray(ifMatch) ? ifMatch[0] : ifMatch;
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            // Conditional write, mirroring the Rust server: re-read disk,
            // compare the If-Match precondition against the current revision
            // (absent files are their own revision), and only then write.
            let currentRevision: string;
            let currentBytes: Buffer | null;
            try {
              currentBytes = fs.readFileSync(filePath);
              currentRevision = computeMockRevision(currentBytes);
            } catch {
              currentBytes = null;
              currentRevision = MOCK_ABSENT_REVISION;
            }
            if (!ifMatchHeader) {
              res.writeHead(428);
              res.end("If-Match header required: POST the revision you accepted from GET /data");
              return;
            }
            if (!mockIfMatchAllows(ifMatchHeader, currentRevision)) {
              res.writeHead(412, { ETag: currentRevision });
              res.end("file changed on disk: If-Match did not match the current revision");
              return;
            }
            const body = Buffer.concat(chunks);
            fs.writeFile(filePath, body, (err) => {
              if (err) {
                res.writeHead(500);
                res.end("write failed");
                return;
              }
              res.writeHead(200, { ETag: computeMockRevision(body) });
              res.end("ok");
            });
          });
          return;
        }
        // GET — bytes + revision (ETag) together, never cached.
        ensureWatched(filePath);
        try {
          const bytes = fs.readFileSync(filePath);
          res.setHeader("Content-Type", contentTypeFor(filePath));
          res.setHeader("ETag", computeMockRevision(bytes));
          res.setHeader("Cache-Control", "no-store");
          res.end(bytes);
        } catch (e) {
          if ((e as { code?: string }).code === "ENOENT") {
            res.writeHead(404, { ETag: MOCK_ABSENT_REVISION });
            res.end(`File not found: ${filePath}`);
          } else {
            res.writeHead(500);
            res.end(`read failed: ${e}`);
          }
        }
      });

      // The LSP's `didClose` attention signal: acknowledge (204) and broadcast
      // `editor-closed` to this file's SSE clients, exactly like the Rust
      // server. No spawn/focus/teardown semantics exist here.
      server.middlewares.use("/editor-closed", (req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
        const filePath = resolveFile(req.url);
        req.on("data", () => {});
        req.on("end", () => {
          broadcastSse(filePath, "editor-closed");
          res.writeHead(204);
          res.end();
        });
      });

      // Narrow WebView↔Rust bridge routes. The dev mock just acknowledges them
      // so `?file=` flows don't 404 when the frontend reports dirty state or a
      // native action result.
      const ack = (req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200);
          res.end("ok");
        });
      };
      server.middlewares.use("/dirty", ack);
      server.middlewares.use("/native-action-result", ack);

      // Native library import is a Rust-dialog flow with no browser equivalent;
      // in dev there's no native menu to trigger it, so just answer 204 (cancel).
      server.middlewares.use("/native-library-request", (req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(204);
          res.end();
        });
      });

      server.middlewares.use("/events", (req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
        const filePath = resolveFile(req.url);
        ensureWatched(filePath);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        res.write(":\n\n");
        const clients = getSseClients(filePath);
        clients.add(res);
        res.on("close", () => clients.delete(res));
      });
    },
  };
}
