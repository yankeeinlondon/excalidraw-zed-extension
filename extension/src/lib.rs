use std::sync::RwLock;
use zed_extension_api::{
    self as zed, Architecture, Command, Extension, LanguageServerId, Os, Result, Worktree,
};

/// Must match the GitHub Release tag (v{VERSION}) **and** the `version` in
/// `extension.toml` — enforced by `test_binary_version_matches_manifest` so an
/// installed user never downloads a binary that predates the shipped manifest.
const BINARY_VERSION: &str = "0.6.0";
const BINARY_NAME: &str = "excalidraw-preview";

struct ExcalidrawPreviewExtension {
    /// Cached path to the downloaded binary, so we don't re-download on every call.
    cached_binary_path: RwLock<Option<String>>,
}

impl ExcalidrawPreviewExtension {
    /// Returns the path to the `excalidraw-preview` binary.
    ///
    /// Resolution order:
    /// 1. `PATH` — honours `make symlink` for local dev.
    /// 2. Previously cached download from this session.
    /// 3. Fresh download from GitHub Releases → cached for the rest of the session.
    fn get_binary_path(&self, worktree: &Worktree) -> Result<String> {
        // 1. Prefer whatever is on PATH (dev / make symlink workflow).
        if let Some(path) = worktree.which(BINARY_NAME) {
            return Ok(path);
        }

        // 2. Return cached download if the file is still there.
        {
            let cache = self.cached_binary_path.read().unwrap();
            if let Some(ref path) = *cache {
                if std::fs::metadata(path).is_ok() {
                    return Ok(path.clone());
                }
            }
        }

        // 3. Download from GitHub Releases.
        let binary_path = self.download_binary()?;
        *self.cached_binary_path.write().unwrap() = Some(binary_path.clone());
        Ok(binary_path)
    }

    /// Downloads the platform-specific binary from GitHub Releases and makes it executable.
    ///
    /// Release asset naming convention:
    ///   `excalidraw-preview-{arch}-{os}`
    /// e.g. `excalidraw-preview-x86_64-unknown-linux-gnu`
    ///      `excalidraw-preview-aarch64-apple-darwin`
    ///      `excalidraw-preview-x86_64-pc-windows-msvc.exe`
    fn download_binary(&self) -> Result<String> {
        let (platform, arch) = zed::current_platform();

        let arch_str = match arch {
            Architecture::Aarch64 => "aarch64",
            Architecture::X8664 => "x86_64",
            Architecture::X86 => "x86",
        };

        let os_str = match platform {
            Os::Mac => "apple-darwin",
            Os::Linux => "unknown-linux-gnu",
            Os::Windows => "pc-windows-msvc",
        };

        let ext = match platform {
            Os::Windows => ".exe",
            _ => "",
        };

        let asset_name = format!("{BINARY_NAME}-{arch_str}-{os_str}{ext}");

        let download_url = format!(
            "https://github.com/yankeeinlondon/excalidraw-zed-extension/releases/download/v{BINARY_VERSION}/{asset_name}"
        );

        // Zed stores downloaded files under the extension's own work directory.
        let output_path = format!("{BINARY_NAME}-{BINARY_VERSION}/{asset_name}");

        zed::download_file(
            &download_url,
            &output_path,
            zed::DownloadedFileType::Uncompressed,
        )
        .map_err(|e| format!("Failed to download {BINARY_NAME}: {e}"))?;

        zed::make_file_executable(&output_path)
            .map_err(|e| format!("Failed to make {BINARY_NAME} executable: {e}"))?;

        Ok(output_path)
    }
}

impl Extension for ExcalidrawPreviewExtension {
    fn new() -> Self {
        ExcalidrawPreviewExtension {
            cached_binary_path: RwLock::new(None),
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        if language_server_id.as_ref() == "excalidraw-preview" {
            let binary = self.get_binary_path(worktree)?;
            Ok(Command {
                command: binary,
                args: vec!["--lsp".into()],
                env: Default::default(),
            })
        } else {
            Err(format!("unknown language server: {language_server_id}"))
        }
    }
}

zed_extension_api::register_extension!(ExcalidrawPreviewExtension);

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Parses the top-level `version = "x.y.z"` out of `extension.toml`,
    /// ignoring keys like `schema_version` and any nested-table `version` lines.
    fn manifest_version() -> String {
        let manifest = include_str!("../extension.toml");
        for line in manifest.lines() {
            let line = line.trim();
            // Stop at the first table header so only the top-level package
            // version (declared before any `[...]` section) is considered.
            if line.starts_with('[') {
                break;
            }
            if let Some(rest) = line.strip_prefix("version") {
                let value = rest.trim_start().trim_start_matches('=').trim();
                return value.trim_matches('"').to_string();
            }
        }
        panic!("extension.toml must declare a top-level `version`");
    }

    #[test]
    fn test_binary_version_matches_manifest() {
        // Guards the release-path drift that shipped a 0.3.0 download tag against
        // a 0.4.0 manifest (review 3, finding 1): installed users download from
        // releases/download/v{BINARY_VERSION}, so this constant must track the
        // published manifest version. Bump both together before each release.
        assert_eq!(
            BINARY_VERSION,
            manifest_version(),
            "BINARY_VERSION must match the `version` in extension.toml; bump it \
             before release so installed users fetch the matching preview binary"
        );
    }

    // ── Language-registration corpus tests (spec §3) ──────────────────────────
    //
    // These parse the *shipped* TOML artifacts (never copies) so the registration
    // strategy cannot silently regress: single-segment `path_suffixes` only, a
    // grammar-less SVG language, and the server mapped to both languages in the
    // manifest. Real-Zed verification of suffix routing is deliberately deferred
    // to Phase 9 (plan.md Checkpoint 2) — a synthetic test cannot validate Zed's
    // suffix matcher, but it can prove we ship the manifest we decided on.

    use std::collections::BTreeSet;
    use std::path::Path;

    /// Path of the shipped artifact `rel`, anchored at the crate root so the
    /// tests pass regardless of the test runner's working directory.
    fn shipped_artifact(rel: &str) -> String {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(rel)
            .to_string_lossy()
            .to_string()
    }

    /// Parses a shipped TOML artifact, panicking with its path on any failure.
    fn parse_shipped_toml(rel: &str) -> toml::Value {
        let path = shipped_artifact(rel);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read shipped artifact {path}: {e}"));
        text.parse::<toml::Value>()
            .unwrap_or_else(|e| panic!("failed to parse shipped artifact {path} as TOML: {e}"))
    }

    /// The parsed `languages/<dir>/config.toml` for a registered language.
    fn language_config(dir: &str) -> toml::Value {
        parse_shipped_toml(&format!("languages/{dir}/config.toml"))
    }

    /// The declared `path_suffixes` of a language config (must be present).
    fn path_suffixes(config: &toml::Value) -> Vec<String> {
        config
            .get("path_suffixes")
            .unwrap_or_else(|| panic!("language config must declare path_suffixes"))
            .as_array()
            .expect("path_suffixes must be an array")
            .iter()
            .map(|v| {
                v.as_str()
                    .expect("path_suffixes entries must be strings")
                    .to_string()
            })
            .collect()
    }

    /// The declared `language_servers` of a language config (must be present).
    fn language_servers(config: &toml::Value) -> Vec<String> {
        config
            .get("language_servers")
            .unwrap_or_else(|| panic!("language config must declare language_servers"))
            .as_array()
            .expect("language_servers must be an array")
            .iter()
            .map(|v| {
                v.as_str()
                    .expect("language_servers entries must be strings")
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn manifest_maps_server_to_exactly_both_languages() {
        let manifest = parse_shipped_toml("extension.toml");
        let server = manifest
            .get("language_servers")
            .and_then(|v| v.get("excalidraw-preview"))
            .expect("extension.toml must declare [language_servers.excalidraw-preview]");

        // The pre-restructure form was `language = "Excalidraw"` + `languages = []`;
        // a surviving singular key (or an empty list) would associate the server
        // with only one language or none.
        assert!(
            server.get("language").is_none(),
            "the singular `language` key must be replaced by the `languages` list"
        );
        let empty: Vec<&str> = Vec::new();
        let languages = server
            .get("languages")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .map(|v| v.as_str().expect("languages entries must be strings"))
                    .collect::<Vec<_>>()
            })
            .unwrap_or(empty);
        assert_eq!(
            languages,
            vec!["Excalidraw", "SVG"],
            "the server must be associated with exactly the Excalidraw and SVG languages"
        );
        assert!(
            server.get("name").and_then(|v| v.as_str()).is_some(),
            "the language server entry must keep a human-readable `name`"
        );
    }

    #[test]
    fn excalidraw_language_claims_only_the_single_segment_suffix() {
        let config = language_config("excalidraw");
        assert_eq!(
            config.get("name").and_then(|v| v.as_str()),
            Some("Excalidraw")
        );
        // The regression this guards: the compound entries ("excalidraw.svg",
        // "excalidraw.png") attach the language in Zed 1.18 but never receive
        // didOpen, which broke click-to-preview for .excalidraw.svg. They are now
        // covered by the SVG language + the in-LSP is_excalidraw_path filter.
        assert_eq!(
            path_suffixes(&config),
            vec!["excalidraw"],
            "Excalidraw must claim exactly the single-segment `excalidraw` suffix"
        );
        assert_eq!(
            language_servers(&config),
            vec!["excalidraw-preview"],
            "the Excalidraw language must attach the excalidraw-preview server"
        );
        assert_eq!(
            config.get("grammar").and_then(|v| v.as_str()),
            Some("json"),
            "the Excalidraw language highlights its JSON scene format with the bundled \
             tree-sitter-json grammar"
        );
    }

    #[test]
    fn svg_language_is_registered_grammarless_pending_retry() {
        let config = language_config("svg");
        assert_eq!(config.get("name").and_then(|v| v.as_str()), Some("SVG"));
        assert_eq!(
            path_suffixes(&config),
            vec!["svg"],
            "SVG must claim exactly the single-segment `svg` suffix"
        );
        assert_eq!(
            language_servers(&config),
            vec!["excalidraw-preview"],
            "every .svg buffer attaches the server; the LSP guard makes plain SVGs an idle no-op"
        );
        // Temporarily grammar-less: the xml grammar and the other config keys added
        // in D15 coincided with .excalidraw.svg click-to-preview breaking while the
        // json-grammar Excalidraw language kept working, so this language is reverted
        // to its last known-working form pending a real-Zed retry. Preview routing is
        // the contract that matters here; highlighting is not. See the config comment.
        assert!(
            config.get("grammar").is_none(),
            "SVG is grammar-less again (D15 diagnostic rollback); re-add `grammar` only \
             once .excalidraw.svg click-to-preview is confirmed working in real Zed"
        );
    }

    #[test]
    fn language_corpus_all_suffixes_single_segment_and_uncontested() {
        // Passive corpus over every shipped language artifact: whatever lands in
        // extension/languages/ must keep the strategy. Compound suffixes
        // (containing '.') are the Zed 1.18 didOpen bug trigger; "png" can never
        // attach because Zed's image pane claims *.png before a buffer exists
        // (finding 6); "json" must stay unclaimed so the server is not spawned
        // for every JSON file the user opens.
        let languages_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("languages");
        let entries = std::fs::read_dir(&languages_dir).expect("extension/languages/ must exist");

        let mut seen: BTreeSet<String> = BTreeSet::new();
        for entry in entries {
            let entry = entry.expect("readable languages/ entry");
            if !entry.path().is_dir() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            let config = language_config(&dir_name);
            seen.insert(dir_name.clone());
            for suffix in path_suffixes(&config) {
                assert!(
                    !suffix.contains('.'),
                    "compound path_suffix {suffix:?} in languages/{dir_name}: Zed 1.18 \
                     attaches the language but never routes didOpen for it"
                );
                assert_ne!(
                    suffix, "png",
                    "languages/{dir_name} claims `png`: Zed's image pane owns *.png, so it \
                     could never attach (finding 6)"
                );
                assert_ne!(
                    suffix, "json",
                    "languages/{dir_name} claims `json`: would spawn the server for every \
                     JSON file"
                );
            }
        }
        assert_eq!(
            seen,
            BTreeSet::from(["excalidraw".to_string(), "svg".to_string()]),
            "languages/ must ship exactly the Excalidraw and SVG languages"
        );
    }

    #[test]
    fn every_language_grammar_is_bundled_and_has_queries() {
        // The failure this guards is a packaging one, not a runtime one: Zed's
        // registry rejects a language whose `grammar` has no matching
        // [grammars.<name>] entry in the manifest ("grammar not found"), and a
        // grammar with no highlights query buys nothing over shipping none at all.
        let manifest = parse_shipped_toml("extension.toml");
        let grammars = manifest
            .get("grammars")
            .and_then(|v| v.as_table())
            .expect("extension.toml must declare [grammars.*] for the bundled grammars");

        let languages_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("languages");
        for entry in std::fs::read_dir(&languages_dir).expect("extension/languages/ must exist") {
            let entry = entry.expect("readable languages/ entry");
            if !entry.path().is_dir() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            let config = language_config(&dir_name);
            let Some(grammar) = config.get("grammar").and_then(|v| v.as_str()) else {
                continue;
            };
            let declared = grammars.get(grammar).unwrap_or_else(|| {
                panic!(
                    "languages/{dir_name} uses grammar {grammar:?}, which extension.toml does \
                     not bundle; the registry packager rejects an undeclared grammar"
                )
            });
            for key in ["repository", "rev"] {
                assert!(
                    declared.get(key).and_then(|v| v.as_str()).is_some(),
                    "[grammars.{grammar}] must pin `{key}` so builds are reproducible"
                );
            }
            // Monorepo grammars live in a subdirectory, and a wrong (or missing)
            // `path` fails only at GUI-gated packaging — every automated gate here
            // passes without it. tree-sitter-xml keeps its grammar in `xml/`;
            // tree-sitter-json is at the repo root and must NOT set `path`
            // (review-2 finding 5).
            let subpath = declared.get("path").and_then(|v| v.as_str());
            let expected_subpath = match grammar {
                "xml" => Some("xml"),
                _ => None,
            };
            assert_eq!(
                subpath, expected_subpath,
                "[grammars.{grammar}] must declare the grammar's subdirectory exactly \
                 ({expected_subpath:?}); the registry builds the wrong directory otherwise"
            );
            assert!(
                entry.path().join("highlights.scm").is_file(),
                "languages/{dir_name} declares a grammar but ships no highlights.scm"
            );
        }
    }
}
