use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const SIGNAL_EXAMPLE_CONFIG: &str = "config/signal.example.yaml";

#[derive(Serialize)]
struct RepositoryScanSummary {
    requested_path: String,
    repository_path: String,
    has_signal_example_config: bool,
    active_workspace_paths: BTreeMap<String, String>,
    top_level_entries: Vec<WorkspaceEntry>,
}

#[derive(Serialize)]
struct WorkspaceEntry {
    name: String,
    path: String,
    kind: String,
}

#[derive(Clone, Copy)]
enum Archetype {
    Prototyper,
    Builder,
    Sweeper,
    Grower,
    Maintainer,
}

#[derive(Serialize)]
struct ArchetypeProfileState {
    archetype: &'static str,
    preferred_runtime: &'static str,
    profile_path: &'static str,
    focus: &'static [&'static str],
    workspace_root: String,
    updated_at_unix: u64,
    source: &'static str,
}

#[tauri::command]
pub fn scan_local_repository(path: String) -> Result<String, String> {
    let root = resolve_user_path(&path)?;

    if !root.is_dir() {
        return Err(format!("{} is not a directory.", root.display()));
    }

    let has_signal_example_config = root.join(SIGNAL_EXAMPLE_CONFIG).is_file();
    let active_workspace_paths = collect_workspace_paths(&root);
    let top_level_entries = collect_top_level_entries(&root)?;

    let summary = RepositoryScanSummary {
        requested_path: path,
        repository_path: display_path(&root),
        has_signal_example_config,
        active_workspace_paths,
        top_level_entries,
    };

    serde_json::to_string_pretty(&summary)
        .map_err(|error| format!("Failed to serialize repository scan: {error}"))
}

#[tauri::command]
pub fn update_archetype_profile(archetype: String) -> Result<bool, String> {
    let archetype = Archetype::parse(&archetype)?;
    let workspace_root = find_common_signal_root()?;
    let state_dir = workspace_root.join(".common-signal").join("local");
    let state_path = state_dir.join("archetype-profile.json");

    fs::create_dir_all(&state_dir).map_err(|error| {
        format!(
            "Failed to create Common Signal local state directory at {}: {error}",
            state_dir.display()
        )
    })?;

    let state = ArchetypeProfileState {
        archetype: archetype.label(),
        preferred_runtime: archetype.preferred_runtime(),
        profile_path: archetype.profile_path(),
        focus: archetype.focus(),
        workspace_root: display_path(&workspace_root),
        updated_at_unix: unix_timestamp()?,
        source: "tauri-local-client",
    };

    write_json_atomically(&state_path, &state)?;
    Ok(true)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            scan_local_repository,
            update_archetype_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running Common Signal desktop application");
}

impl Archetype {
    fn parse(input: &str) -> Result<Self, String> {
        match input.trim().to_ascii_lowercase().as_str() {
            "prototyper" => Ok(Self::Prototyper),
            "builder" => Ok(Self::Builder),
            "sweeper" => Ok(Self::Sweeper),
            "grower" => Ok(Self::Grower),
            "maintainer" => Ok(Self::Maintainer),
            value if value.is_empty() => Err("Archetype selection cannot be empty.".to_string()),
            value => Err(format!("Unsupported Common Signal archetype: {value}.")),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Prototyper => "Prototyper",
            Self::Builder => "Builder",
            Self::Sweeper => "Sweeper",
            Self::Grower => "Grower",
            Self::Maintainer => "Maintainer",
        }
    }

    fn preferred_runtime(self) -> &'static str {
        match self {
            Self::Prototyper | Self::Grower => "gemini",
            Self::Builder | Self::Sweeper => "claude",
            Self::Maintainer => "chatgpt",
        }
    }

    fn profile_path(self) -> &'static str {
        match self {
            Self::Prototyper | Self::Grower => "agents/gemini/context-indexer.md",
            Self::Builder | Self::Sweeper => "agents/claude/builder-profile.md",
            Self::Maintainer => "agents/chatgpt/maintainer-profile.md",
        }
    }

    fn focus(self) -> &'static [&'static str] {
        match self {
            Self::Prototyper => &["first-pass", "feasibility", "fast-feedback"],
            Self::Builder => &["implementation", "structure", "tests"],
            Self::Sweeper => &["cleanup", "migration", "consistency"],
            Self::Grower => &["expansion", "docs", "scale-paths"],
            Self::Maintainer => &["reliability", "security", "regression-control"],
        }
    }
}

fn resolve_user_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return Err("Repository path cannot be empty.".to_string());
    }

    let current_dir = std::env::current_dir()
        .map_err(|error| format!("Failed to read current working directory: {error}"))?;
    let candidate = PathBuf::from(trimmed);
    let absolute_candidate = if candidate.is_absolute() {
        candidate
    } else {
        find_common_signal_root_from(&current_dir)
            .unwrap_or(current_dir)
            .join(candidate)
    };

    absolute_candidate.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve repository path {}: {error}",
            absolute_candidate.display()
        )
    })
}

fn collect_workspace_paths(root: &Path) -> BTreeMap<String, String> {
    let candidates = [
        ("root", PathBuf::from(".")),
        ("config", PathBuf::from("config")),
        ("signal_example_config", PathBuf::from(SIGNAL_EXAMPLE_CONFIG)),
        ("agents", PathBuf::from("agents")),
        ("github_workflows", PathBuf::from(".github/workflows")),
        ("gitlab_ci", PathBuf::from(".gitlab/ci")),
        ("desktop_client", PathBuf::from("src-tauri")),
        ("frontend", PathBuf::from("src")),
        ("local_state", PathBuf::from(".common-signal")),
    ];

    candidates
        .into_iter()
        .filter_map(|(name, relative_path)| {
            let full_path = root.join(relative_path);

            if full_path.exists() {
                Some((name.to_string(), display_path(&full_path)))
            } else {
                None
            }
        })
        .collect()
}

fn collect_top_level_entries(root: &Path) -> Result<Vec<WorkspaceEntry>, String> {
    let entries = fs::read_dir(root)
        .map_err(|error| format!("Failed to read directory {}: {error}", root.display()))?;

    let mut summaries = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "Failed to read a directory entry under {}: {error}",
                root.display()
            )
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            format!("Failed to inspect directory entry {}: {error}", path.display())
        })?;

        summaries.push(WorkspaceEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: display_path(&path),
            kind: if file_type.is_dir() {
                "directory"
            } else if file_type.is_file() {
                "file"
            } else if file_type.is_symlink() {
                "symlink"
            } else {
                "other"
            }
            .to_string(),
        });
    }

    summaries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(summaries)
}

fn find_common_signal_root() -> Result<PathBuf, String> {
    let current_dir = std::env::current_dir()
        .map_err(|error| format!("Failed to read current working directory: {error}"))?;

    find_common_signal_root_from(&current_dir).ok_or_else(|| {
        format!(
            "Could not find {SIGNAL_EXAMPLE_CONFIG} from {} or its parents.",
            current_dir.display()
        )
    })
}

fn find_common_signal_root_from(start: &Path) -> Option<PathBuf> {
    for candidate in start.ancestors() {
        if candidate.join(SIGNAL_EXAMPLE_CONFIG).is_file() {
            return candidate.canonicalize().ok();
        }
    }

    None
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to serialize archetype profile state: {error}"))?;
    let temp_path = path.with_extension("json.tmp");

    fs::write(&temp_path, format!("{body}\n")).map_err(|error| {
        format!(
            "Failed to write temporary archetype profile state at {}: {error}",
            temp_path.display()
        )
    })?;

    match fs::rename(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(rename_error) if path.exists() => {
            fs::remove_file(path).map_err(|remove_error| {
                format!(
                    "Failed to replace existing archetype profile state at {}: {remove_error}",
                    path.display()
                )
            })?;
            fs::rename(&temp_path, path).map_err(|second_rename_error| {
                format!(
                    "Failed to move archetype profile state from {} to {} after replace attempt: {second_rename_error}; original rename error: {rename_error}",
                    temp_path.display(),
                    path.display()
                )
            })
        }
        Err(error) => Err(format!(
            "Failed to move archetype profile state from {} to {}: {error}",
            temp_path.display(),
            path.display()
        )),
    }
}

fn unix_timestamp() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| format!("System clock is before the Unix epoch: {error}"))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
