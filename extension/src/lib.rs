use std::sync::RwLock;
use zed_extension_api::{
    self as zed, Architecture, Command, Extension, LanguageServerId, Os, Result, Worktree,
};

/// Must match the GitHub Release tag (v{VERSION}) **and** the `version` in
/// `extension.toml` — enforced by `test_binary_version_matches_manifest` so an
/// installed user never downloads a binary that predates the shipped manifest.
const BINARY_VERSION: &str = "0.5.1";
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
}
