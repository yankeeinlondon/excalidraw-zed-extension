use std::path::{Path, PathBuf};
use std::sync::RwLock;
use zed_extension_api::{
    self as zed,
    process::Command as ProcessCommand,
    Architecture, Command, Extension, LanguageServerId, Os, Range, Result, SlashCommand,
    SlashCommandOutput, SlashCommandOutputSection, Worktree,
};

/// Must match the GitHub Release tag (v{VERSION}) **and** the `version` in
/// `extension.toml` — enforced by `test_binary_version_matches_manifest` so an
/// installed user never downloads a binary that predates the shipped manifest.
const BINARY_VERSION: &str = "0.4.0";
const BINARY_NAME: &str = "excalidraw-preview";

struct ExcalidrawPreviewExtension {
    /// Cached path to the downloaded binary, so we don't re-download on every call.
    cached_binary_path: RwLock<Option<String>>,
}

impl ExcalidrawPreviewExtension {
    fn is_valid_extension(path: &Path) -> bool {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        name.ends_with(".excalidraw")
            || name.ends_with(".excalidraw.svg")
            || name.ends_with(".excalidraw.png")
    }

    fn find_excalidraw_file(worktree: &Worktree) -> Option<PathBuf> {
        let root_path = PathBuf::from(worktree.root_path());
        if let Ok(entries) = std::fs::read_dir(&root_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && Self::is_valid_extension(&path) {
                    return Some(path);
                }
            }
        }
        None
    }

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

    fn run_slash_command(
        &self,
        command: SlashCommand,
        args: Vec<String>,
        worktree: Option<&Worktree>,
    ) -> Result<SlashCommandOutput> {
        match command.name.as_str() {
            "preview-excalidraw" => {
                let worktree = worktree.ok_or("No worktree available")?;

                let binary = self.get_binary_path(worktree)?;

                // Separate flags (--auto-save) from the positional file argument.
                let auto_save = args.contains(&"--auto-save".to_string());
                let file_arg = args.iter().find(|a| !a.starts_with("--"));

                let file_path = if let Some(file_arg) = file_arg {
                    let p = PathBuf::from(file_arg);
                    if p.is_absolute() {
                        p
                    } else {
                        PathBuf::from(worktree.root_path()).join(&p)
                    }
                } else {
                    Self::find_excalidraw_file(worktree).ok_or(
                        "No .excalidraw file found in workspace. Provide a file path as argument.",
                    )?
                };

                if !Self::is_valid_extension(&file_path) {
                    return Err(
                        "File must end with .excalidraw, .excalidraw.svg, or .excalidraw.png"
                            .into(),
                    );
                }

                let file_path_str = file_path.to_string_lossy().to_string();

                // The binary self-daemonizes (re-spawns detached, parent exits instantly),
                // and self-deduplicates via its lock file: if a live instance is already
                // serving this file it focuses that window and exits. So we always just run it.
                let mut cmd = ProcessCommand::new(&binary).arg(&file_path_str);
                if auto_save {
                    cmd = cmd.arg("--auto-save");
                }
                match cmd.output() {
                    Ok(_) => Ok(SlashCommandOutput {
                        sections: vec![SlashCommandOutputSection {
                            range: Range { start: 0, end: 1 },
                            label: "Preview opened".into(),
                        }],
                        text: format!("Opened preview for {}", file_path.display()),
                    }),
                    Err(e) => Err(format!("Failed to start preview: {e}")),
                }
            }
            "new-excalidraw" => {
                let worktree = worktree.ok_or("No worktree available")?;
                let binary = self.get_binary_path(worktree)?;
                let root = PathBuf::from(worktree.root_path());

                let file_path = if let Some(name) = args.iter().find(|a| !a.starts_with("--")) {
                    let mut name = name.to_string();
                    if !name.ends_with(".excalidraw") {
                        name.push_str(".excalidraw");
                    }
                    root.join(name)
                } else {
                    (1..1000)
                        .map(|n| root.join(format!("untitled-{n}.excalidraw")))
                        .find(|p| !p.exists())
                        .ok_or("Could not find a free untitled-N.excalidraw name")?
                };

                if file_path.exists() {
                    return Err(format!("{} already exists", file_path.display()));
                }

                let file_path_str = file_path.to_string_lossy().to_string();
                match ProcessCommand::new(&binary)
                    .arg("--new")
                    .arg(&file_path_str)
                    .output()
                {
                    Ok(_) => Ok(SlashCommandOutput {
                        sections: vec![SlashCommandOutputSection {
                            range: Range { start: 0, end: 1 },
                            label: "Drawing created".into(),
                        }],
                        text: format!("Created and opened {}", file_path.display()),
                    }),
                    Err(e) => Err(format!("Failed to create drawing: {e}")),
                }
            }
            _ => Err(format!("Unknown command: {}", command.name)),
        }
    }
}

zed_extension_api::register_extension!(ExcalidrawPreviewExtension);

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_extension_json() {
        assert!(ExcalidrawPreviewExtension::is_valid_extension(
            &PathBuf::from("diagram.excalidraw")
        ));
    }

    #[test]
    fn test_is_valid_extension_svg() {
        assert!(ExcalidrawPreviewExtension::is_valid_extension(
            &PathBuf::from("diagram.excalidraw.svg")
        ));
    }

    #[test]
    fn test_is_valid_extension_png() {
        assert!(ExcalidrawPreviewExtension::is_valid_extension(
            &PathBuf::from("diagram.excalidraw.png")
        ));
    }

    #[test]
    fn test_is_valid_extension_rejects_plain_svg() {
        assert!(!ExcalidrawPreviewExtension::is_valid_extension(
            &PathBuf::from("diagram.svg")
        ));
    }

    #[test]
    fn test_is_valid_extension_rejects_plain_json() {
        assert!(!ExcalidrawPreviewExtension::is_valid_extension(
            &PathBuf::from("diagram.json")
        ));
    }

    #[test]
    fn test_is_valid_extension_rejects_empty() {
        assert!(!ExcalidrawPreviewExtension::is_valid_extension(
            &PathBuf::from("")
        ));
    }

    #[test]
    fn test_is_valid_extension_with_absolute_path() {
        assert!(ExcalidrawPreviewExtension::is_valid_extension(
            &PathBuf::from("/home/user/diagrams/arch.excalidraw")
        ));
    }

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
