## Feature

Bring **all** dependencies — frontend (npm) and Rust (Cargo) — as close to latest as
possible. Preference is to upgrade everything; skip only where a hard incompatibility
exists. Analysis below concludes: **there are no hard blockers** — every package can be
upgraded. A handful require small, mechanical code edits.

Environment baseline (verified): Node **v22.20.0**, rustc **1.96.0** (no pinned toolchain),
tsconfig already has `strict: true` + `moduleResolution: "bundler"`. Excalidraw 0.18 peer-deps
allow `react ^19`. These facts make the risky-looking jumps low-risk in practice.

---

## Frontend (npm) — `preview-binary/webview-src/`

| Package | Current | Latest | Kind | Effort | Notes |
|---|---|---|---|---|---|
| @excalidraw/excalidraw | 0.18.0 | 0.18.1 | patch | trivial | Bug-fix only |
| @types/node | 25.5.2 | 25.9.3 | minor | trivial | — |
| react / react-dom | 18.3.1 | 19.2.7 | **major** | low | Excalidraw 0.18 peer-deps `^19`. Our usage is minimal/idiomatic (`useState/useEffect/useCallback/useRef`, `createRoot`) — all stable in 19. No legacy patterns. |
| @types/react / @types/react-dom | 18.3 | 19.2 | **major** | low | Track react 19 |
| @vitejs/plugin-react | 4.7.0 | 6.0.2 | **major** | low | v6 **requires Vite 8**. Babel removed (Oxc handles fast-refresh). We use default fast-refresh + no custom Babel → drop-in. |
| vite | 5.4.21 | 8.0.16 | **major×3** | medium | Rolldown bundler swap. Our `mockApiPlugin` uses `configureServer` (a **stable** hook, unaffected). Config renames are auto-shimmed. Node 22.20 satisfies the 20.19/22.12 floor. |
| vitest | 3.2.6 | 4.1.8 | **major** | low–med | Vitest 4 **adds Vite 8 support**. Config edits *if* we use `poolOptions`/`maxThreads`/`coverage.all` (we likely don't). `environment: jsdom/node` unaffected. |
| typescript | 5.9.3 | 6.0.3 | **major** | low–med | TS 6 = final JS-based release, 5.9-API-compatible (transitional before Go-native 7.0). New default `types: []` may require adding `"types": ["node"]` for vite.config. We already set `strict`/`bundler`. |

**Mutual compatibility:** designed to ship together — plugin-react 6 forces Vite 8, Vitest 4 + Vite 8 co-released. **Caveat:** add a `vite: ^8` override in `package.json` so Vitest's transitive Vite dedupes to a single v8.

**Suggested sequence:**
1. TS 6 first (isolated, type-check only) — add `types: ["node"]` if needed.
2. Vite 5→8 + plugin-react 4→6 together (coupled) + `vite` override — verify `vite build`, the dev-server `mockApiPlugin` middleware, the `?file=` flow, and the Excalidraw render path.
3. Vitest 3→4 last — audit `vi.restoreAllMocks`/`vi.fn` mocking-semantics changes in existing tests; apply any `coverage`/pool config edits.
4. react 18→19 + @types, and the excalidraw/node patch bumps (low risk, can ride along).

---

## Rust (Cargo) — `preview-binary/`

| Crate | Current | Latest | Effort | Code change needed |
|---|---|---|---|---|
| **wry** | 0.43.1 | 0.55.1 | low–med | **Yes** — builder API moved (see below) |
| **tao** | 0.30.8 | 0.35.3 | trivial | **No** — `EventLoop::new()` + `run` closure unchanged; rwh 0.6 lands automatically |
| **notify** | 6.1.1 | 8.2.0 | low | No — core watch API + re-exported types unchanged. Only check `Cargo.toml` doesn't use the renamed `crossbeam` feature (we don't). |
| **reqwest** | 0.12.28 | 0.13.4 | low | No — `json`/`blocking` unchanged. Loopback pings hit no TLS. `query`/`form` are now opt-in features — add only if used (we don't). |
| **rfd** | 0.15.4 | 0.17.2 | low | No — sync `save_file()` chain unchanged; **gtk3 stays the default Linux backend** (not moved to xdg-portal). Run `cargo tree -d` to confirm no duplicate gtk/glib vs our direct `gtk 0.18`. |
| **sha2** | 0.10.9 | 0.11.0 | low | No — `new/update/finalize` unchanged. Pulls **digest 0.11** (likely duplicates digest 0.10 already in tree — harmless, self-contained use). MSRV 1.85 ✓ (we're on 1.96). Drop any `asm`/`std` sha2 features (we don't set them). **Marginal benefit — candidate to skip.** |
| axum | 0.8.8 | 0.8.9 | trivial | No — patch |
| clap | 4.6.0 | 4.6.1 | trivial | No — patch |
| hyper | 1.9.0 | 1.10.1 | trivial | No — minor |
| serde_json | 1.0.149 | 1.0.150 | trivial | No — patch |
| tokio | 1.51.1 | 1.52.3 | trivial | No — minor |

### wry 0.43 → 0.55 — required edits (in `preview-binary/src/main.rs`)

The window moved from `new()` into `build()` (wry 0.46), and `new_gtk` was replaced by `build_gtk`.

**Non-Linux (tao path):**
```rust
// before
let _webview = WebViewBuilder::new(&window).with_url(url).build()?;
// after
let _webview = WebViewBuilder::new().with_url(url).build(&window)?;
```

**Linux (gtk path):**
```rust
// before
let _webview = wry::WebViewBuilder::new_gtk(&window).with_url(url).build()?;
// after
let _webview = wry::WebViewBuilder::new().with_url(url).build_gtk(&window)?;
```

tao 0.35's `Window` implements `HasWindowHandle` (rwh 0.6), satisfying wry's `build<W: HasWindowHandle>` bound — no manual feature pinning. The event-loop/windowing code is untouched.

---

## Decision

**Recommendation: upgrade everything to latest.** No hard incompatibilities exist. Total
code-change surface is small: the wry builder edits (2 call sites) + a possible
`types: ["node"]` tsconfig line + a `vite: ^8` package.json override. Everything else is a
version-number bump.

**Only genuine judgment call:** `sha2 0.10 → 0.11` brings a duplicate `digest` crate version
into the tree for zero functional gain (we only hash a path string). Functionally harmless,
but it's the one upgrade with no upside. Decision recorded below.

### Verification checklist (post-upgrade)
- `cargo tree -d` — catch duplicate gtk/glib (rfd vs gtk 0.18) and digest 0.10/0.11 split.
- `just test` (nextest + doctests + vitest) on macOS; CI covers windows-latest.
- Manual: open all three formats (.excalidraw / .svg / .png), confirm live-reload + export dialog.
- `vite build` + dev-server `mockApiPlugin` + `?file=` flow.
