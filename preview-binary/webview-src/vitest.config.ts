import { defineConfig } from "vitest/config";

// Dedicated test config so vitest does NOT load vite.config.ts, whose dev-only
// `mockApiPlugin` runs Node `require`/`fs.watch`/`execSync` side effects at config
// load time (vitest evaluates the config with command === "serve"). The unit tests
// exercise pure functions and mock `@excalidraw/excalidraw`, so a plain Node
// environment with no plugins is all they need.
export default defineConfig({
  test: {
    environment: "node",
  },
});
