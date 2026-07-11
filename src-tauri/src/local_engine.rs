use crate::hardware::{build_hardware_profile, HardwareProfile, CLOUD_BRIDGE_RAM_GB};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};
use tauri::{path::BaseDirectory, AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const DEFAULT_OLLAMA_API_BASE: &str = "http://127.0.0.1:11434";
const OLLAMA_VERSION_PATH: &str = "/api/version";
const OLLAMA_TAGS_PATH: &str = "/api/tags";
const OLLAMA_PULL_PATH: &str = "/api/pull";
const PING_TIMEOUT_SECONDS: u64 = 2;
const SIDECAR_STARTUP_ATTEMPTS: usize = 12;
const SIDECAR_STARTUP_DELAY_MS: u64 = 750;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEngineBootstrap {
    hardware: HardwareProfile,
    provider_route: ProviderRoute,
    local_runtime: LocalRuntimeState,
    heavy_role_ram_threshold_gb: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRoute {
    provider: &'static str,
    base_url: &'static str,
    model: String,
    api_key_required: bool,
    source: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalRuntimeState {
    api_base: &'static str,
    reachable: bool,
    version: Option<String>,
    launched_sidecar: bool,
    sidecar_pid: Option<u32>,
    sidecar_error: Option<String>,
    models_path: String,
    default_model: String,
    default_model_ready: bool,
    default_model_pull_started: bool,
    default_model_error: Option<String>,
    status: String,
}

#[derive(Deserialize)]
struct OllamaVersionResponse {
    version: Option<String>,
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

#[derive(Deserialize)]
struct OllamaModel {
    name: String,
}

struct SidecarLaunch {
    launched: bool,
    pid: Option<u32>,
    error: Option<String>,
}

struct ModelAvailability {
    ready: bool,
    pull_started: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn bootstrap_local_engine(app: AppHandle) -> Result<LocalEngineBootstrap, String> {
    let hardware = build_hardware_profile();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve Common Signal user data directory: {error}"))?;
    let models_dir = app_data_dir.join("ollama-models");

    fs::create_dir_all(&models_dir).map_err(|error| {
        format!(
            "Failed to create local Ollama model directory at {}: {error}",
            models_dir.display()
        )
    })?;

    let mut sidecar_launch = SidecarLaunch {
        launched: false,
        pid: None,
        error: None,
    };
    let mut version = ping_ollama_version(DEFAULT_OLLAMA_API_BASE)
        .ok()
        .flatten();

    if version.is_none() {
        sidecar_launch = launch_ollama_sidecar(&app, &models_dir);

        if sidecar_launch.launched {
            version = wait_for_ollama(DEFAULT_OLLAMA_API_BASE);
        }
    }

    let reachable = version.is_some();
    let default_model = hardware.default_local_model.clone();
    let model_availability = if reachable {
        ensure_default_model(DEFAULT_OLLAMA_API_BASE, &default_model)
    } else {
        ModelAvailability {
            ready: false,
            pull_started: false,
            error: Some(
                sidecar_launch
                    .error
                    .clone()
                    .unwrap_or_else(|| "Ollama is not reachable yet.".to_string()),
            ),
        }
    };

    let local_runtime = LocalRuntimeState {
        api_base: DEFAULT_OLLAMA_API_BASE,
        reachable,
        version,
        launched_sidecar: sidecar_launch.launched,
        sidecar_pid: sidecar_launch.pid,
        sidecar_error: sidecar_launch.error,
        models_path: display_path(&models_dir),
        default_model: default_model.clone(),
        default_model_ready: model_availability.ready,
        default_model_pull_started: model_availability.pull_started,
        default_model_error: model_availability.error,
        status: runtime_status(reachable, &default_model),
    };

    Ok(LocalEngineBootstrap {
        hardware,
        provider_route: ProviderRoute {
            provider: "ollama",
            base_url: DEFAULT_OLLAMA_API_BASE,
            model: default_model,
            api_key_required: false,
            source: "local-engine",
        },
        local_runtime,
        heavy_role_ram_threshold_gb: CLOUD_BRIDGE_RAM_GB,
    })
}

pub fn list_ollama_model_names(api_base: &str) -> Result<Vec<String>, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|error| format!("Failed to create Ollama HTTP client: {error}"))?;
    let response = client
        .get(join_url(api_base, OLLAMA_TAGS_PATH))
        .send()
        .map_err(|error| format!("Ollama is not reachable: {error}"))?;
    let status = response.status();

    if !status.is_success() {
        return Err(format!("Ollama responded with HTTP status {status}."));
    }

    let payload = response
        .json::<OllamaTagsResponse>()
        .map_err(|error| format!("Failed to parse Ollama /api/tags JSON: {error}"))?;
    let mut model_names: Vec<String> = payload
        .models
        .into_iter()
        .map(|model| model.name)
        .filter(|name| !name.trim().is_empty())
        .collect();

    model_names.sort();
    model_names.dedup();
    Ok(model_names)
}

fn ping_ollama_version(api_base: &str) -> Result<Option<String>, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(PING_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| format!("Failed to create Ollama HTTP client: {error}"))?;
    let response = client
        .get(join_url(api_base, OLLAMA_VERSION_PATH))
        .send()
        .map_err(|error| format!("Ollama version ping failed: {error}"))?;

    if response.status().as_u16() != 200 {
        return Err(format!(
            "Ollama version ping returned HTTP status {}.",
            response.status()
        ));
    }

    let payload = response
        .json::<OllamaVersionResponse>()
        .map_err(|error| format!("Failed to parse Ollama /api/version JSON: {error}"))?;

    Ok(payload.version.or_else(|| Some("unknown".to_string())))
}

fn wait_for_ollama(api_base: &str) -> Option<String> {
    for _ in 0..SIDECAR_STARTUP_ATTEMPTS {
        if let Ok(version) = ping_ollama_version(api_base) {
            return version;
        }

        thread::sleep(Duration::from_millis(SIDECAR_STARTUP_DELAY_MS));
    }

    None
}

fn launch_ollama_sidecar(app: &AppHandle, models_dir: &Path) -> SidecarLaunch {
    let binary_path = match resolve_ollama_binary(app) {
        Ok(path) => path,
        Err(error) => {
            return SidecarLaunch {
                launched: false,
                pid: None,
                error: Some(error),
            };
        }
    };
    let mut command = Command::new(&binary_path);

    command
        .arg("serve")
        .env("OLLAMA_MODELS", models_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;

        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    match command.spawn() {
        Ok(child) => SidecarLaunch {
            launched: true,
            pid: Some(child.id()),
            error: None,
        },
        Err(error) => SidecarLaunch {
            launched: false,
            pid: None,
            error: Some(format!(
                "Failed to launch bundled Ollama sidecar at {}: {error}",
                binary_path.display()
            )),
        },
    }
}

fn resolve_ollama_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Ok(path) = std::env::var("COMMON_SIGNAL_OLLAMA_BIN") {
        candidates.push(PathBuf::from(path));
    }

    for relative_path in bundled_ollama_candidates() {
        if let Ok(path) = app.path().resolve(relative_path, BaseDirectory::Resource) {
            candidates.push(path);
        }
    }

    if let Ok(workspace_root) = crate::find_common_signal_root() {
        for relative_path in bundled_ollama_candidates() {
            candidates.push(workspace_root.join(relative_path));
        }
    }

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!(
                "Ollama is not running and no bundled sidecar binary was found. Expected {} under bin/ollama or set COMMON_SIGNAL_OLLAMA_BIN for local development.",
                ollama_executable_name()
            )
        })
}

fn bundled_ollama_candidates() -> Vec<PathBuf> {
    let executable_name = ollama_executable_name();

    vec![
        PathBuf::from("bin").join("ollama").join(executable_name),
        PathBuf::from("bin").join(executable_name),
        PathBuf::from("ollama").join(executable_name),
        PathBuf::from(executable_name),
    ]
}

fn ollama_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ollama.exe"
    } else {
        "ollama"
    }
}

fn ensure_default_model(api_base: &str, model: &str) -> ModelAvailability {
    match list_ollama_model_names(api_base) {
        Ok(model_names) if model_names.iter().any(|name| model_name_matches(name, model)) => {
            ModelAvailability {
                ready: true,
                pull_started: false,
                error: None,
            }
        }
        Ok(_) => match start_model_pull(api_base, model) {
            Ok(()) => ModelAvailability {
                ready: false,
                pull_started: true,
                error: None,
            },
            Err(error) => ModelAvailability {
                ready: false,
                pull_started: false,
                error: Some(error),
            },
        },
        Err(error) => ModelAvailability {
            ready: false,
            pull_started: false,
            error: Some(error),
        },
    }
}

fn start_model_pull(api_base: &str, model: &str) -> Result<(), String> {
    let pull_url = join_url(api_base, OLLAMA_PULL_PATH);
    let model = model.to_string();

    thread::Builder::new()
        .name("common-signal-ollama-pull".to_string())
        .spawn(move || {
            let client = match Client::builder().timeout(Duration::from_secs(60 * 60)).build() {
                Ok(client) => client,
                Err(_) => return,
            };

            let _ = client
                .post(pull_url)
                .json(&json!({
                    "name": model,
                    "stream": false
                }))
                .send();
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to start local model pull: {error}"))
}

fn model_name_matches(installed_name: &str, expected_name: &str) -> bool {
    if installed_name == expected_name {
        return true;
    }

    match installed_name.strip_suffix(":latest") {
        Some(prefix) => prefix == expected_name,
        None => false,
    }
}

fn runtime_status(reachable: bool, default_model: &str) -> String {
    if reachable {
        format!("Local engine is connected. Default model: {default_model}.")
    } else {
        "Local engine is not reachable yet. Cloud Bridge can still be configured from the client."
            .to_string()
    }
}

fn join_url(api_base: &str, path: &str) -> String {
    format!("{}{}", api_base.trim_end_matches('/'), path)
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
