import { defineConfig } from "vitest/config";

// Dedicated test config so vitest does NOT load vite.config.ts, whose dev-only
// `mockApiPlugin` runs Node `require`/`fs.watch`/`execSync` side effects at config
// load time (vitest evaluates the config with command === "serve"). The unit tests
// exercise pure functions and mock `@excalidraw/excalidraw`, so a plain Node
// environment with no plugins is all they need.
export default defineConfig({
  test: {
    environment: "node",
    // The vendored-package proxy tests (color-mode-persistence restore() checks)
    // import the REAL @excalidraw/excalidraw dev dist, whose ESM uses
    // bundler-only extensionless specifiers (`roughjs/bin/rough`) that node's
    // loader rejects. Inlining routes those through vite's resolver. Tests that
    // `vi.mock` the package never load it, so this only affects the proxies.
    server: {
      deps: {
        inline: [/@excalidraw[\\/]excalidraw/],
      },
    },
  },
});
