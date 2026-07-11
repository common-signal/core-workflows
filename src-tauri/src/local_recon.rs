use crate::hardware::{build_hardware_profile, HardwareProfile, CLOUD_BRIDGE_RAM_GB};
use async_trait::async_trait;
use mistralrs::{GgufModelBuilder, TextMessageRole, TextMessages};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, State};
use thiserror::Error;

const LOCAL_RECON_EVENT: &str = "local-recon://download-progress";
const LOCAL_RECON_CACHE_DIR: &str = "local-recon-models";
const EMBEDDED_MISTRAL_BASE_URL: &str = "embedded://mistral.rs";
const LOCAL_RECON_SYSTEM_PROMPT: &str = "Extract the core technical intent from the user's input. Strip all emotional, redundant, or formatting instructions. Output ONLY the most minimal, precise instruction required for a senior AI to execute the task.";

#[derive(Clone, Copy)]
struct LocalModelProfile {
    id: &'static str,
    label: &'static str,
    repo_id: &'static str,
    gguf_file: &'static str,
    tokenizer_repo: &'static str,
    quantization: &'static str,
    context_window: u32,
    min_ram_gb: u64,
    recommended_vram_gb: u64,
    estimated_size_gb: f32,
    tier: &'static str,
}

const SUPPORTED_LOCAL_MODELS: &[LocalModelProfile] = &[
    LocalModelProfile {
        id: "phi3-mini-4k-instruct-q4",
        label: "Phi-3 Mini 4K Instruct Q4",
        repo_id: "microsoft/Phi-3-mini-4k-instruct-gguf",
        gguf_file: "Phi-3-mini-4k-instruct-q4.gguf",
        tokenizer_repo: "microsoft/Phi-3-mini-4k-instruct",
        quantization: "Q4",
        context_window: 4096,
        min_ram_gb: 8,
        recommended_vram_gb: 0,
        estimated_size_gb: 2.4,
        tier: "low-end",
    },
    LocalModelProfile {
        id: "llama3-8b-instruct-q4",
        label: "Llama 3 8B Instruct Q4_K_M",
        repo_id: "bartowski/Meta-Llama-3-8B-Instruct-GGUF",
        gguf_file: "Meta-Llama-3-8B-Instruct-Q4_K_M.gguf",
        tokenizer_repo: "meta-llama/Meta-Llama-3-8B-Instruct",
        quantization: "Q4_K_M",
        context_window: 8192,
        min_ram_gb: 16,
        recommended_vram_gb: 6,
        estimated_size_gb: 4.9,
        tier: "mid-tier",
    },
    LocalModelProfile {
        id: "qwen25-coder-7b-instruct-q4",
        label: "Qwen2.5 Coder 7B Instruct Q4_K_M",
        repo_id: "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
        gguf_file: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        tokenizer_repo: "Qwen/Qwen2.5-Coder-7B-Instruct",
        quantization: "Q4_K_M",
        context_window: 32768,
        min_ram_gb: 24,
        recommended_vram_gb: 8,
        estimated_size_gb: 4.7,
        tier: "technical",
    },
];

#[derive(Default)]
pub struct LocalReconState {
    loaded_model: Mutex<Option<LoadedLocalModel>>,
}

struct LoadedLocalModel {
    model_id: String,
    model: Arc<mistralrs::Model>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReconBootstrap {
    hardware: HardwareProfile,
    provider_route: ProviderRoute,
    local_runtime: LocalRuntimeState,
    supported_models: Vec<LocalModelDescriptor>,
    recommended_model_id: String,
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
    engine: &'static str,
    embedded: bool,
    reachable: bool,
    models_path: String,
    default_model: String,
    recommended_model_id: String,
    selected_model_ready: bool,
    status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelDescriptor {
    id: String,
    label: String,
    repo_id: String,
    gguf_file: String,
    tokenizer_repo: String,
    quantization: String,
    context_window: u32,
    min_ram_gb: u64,
    recommended_vram_gb: u64,
    estimated_size_gb: f32,
    tier: String,
    recommended: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReconModelReady {
    model: LocalModelDescriptor,
    cached: bool,
    models_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalReconProgress {
    model_id: String,
    phase: &'static str,
    message: String,
    progress: Option<f32>,
    cached: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReconDistillation {
    raw_intent: String,
    distilled_output: String,
    raw_token_estimate: u64,
    distilled_token_estimate: u64,
    tokens_saved: u64,
    model_id: String,
    model_label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaidDispatchRequest {
    provider: PaidProvider,
    api_key: String,
    model: String,
    prompt: String,
}

#[derive(Clone, Copy, Deserialize)]
enum PaidProvider {
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "anthropic")]
    Anthropic,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaidDispatchResponse {
    provider: String,
    model: String,
    output: String,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

#[derive(Debug, Error)]
enum LocalReconError {
    #[error("No Local Recon models are configured.")]
    NoModels,
    #[error("Unsupported Local Recon model: {0}.")]
    UnsupportedModel(String),
    #[error("Raw intent cannot be empty.")]
    EmptyIntent,
    #[error("Distilled prompt cannot be empty.")]
    EmptyDistilledPrompt,
    #[error("Failed to resolve Common Signal app data directory: {0}")]
    AppDataDir(String),
    #[error("Failed to {action} at {path}: {source}")]
    Io {
        action: &'static str,
        path: String,
        source: std::io::Error,
    },
    #[error("mistral.rs could not load {model_id}: {source}")]
    ModelLoad { model_id: String, source: String },
    #[error("mistral.rs inference failed: {0}")]
    Inference(String),
    #[error("Local Recon model state is unavailable: {0}")]
    State(String),
    #[error("Local Recon did not return text content.")]
    MissingContent,
    #[error(transparent)]
    Dispatch(#[from] ApiDispatchError),
}

#[derive(Debug, Error)]
enum ApiDispatchError {
    #[error("API key is required for {0}.")]
    MissingApiKey(String),
    #[error("Paid model name is required for {0}.")]
    MissingModel(String),
    #[error("Paid provider HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Provider(String),
    #[error("Paid provider response did not include text content.")]
    MissingContent,
}

#[async_trait]
trait PaidModelClient {
    async fn dispatch(
        &self,
        prompt: &str,
        model: &str,
    ) -> Result<PaidDispatchResponse, ApiDispatchError>;
}

struct OpenAiClient {
    http: reqwest::Client,
    api_key: String,
    base_url: &'static str,
}

struct AnthropicClient {
    http: reqwest::Client,
    api_key: String,
    base_url: &'static str,
}

#[derive(Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<OpenAiChoice>,
    usage: Option<OpenAiUsage>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Deserialize)]
struct OpenAiMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct AnthropicMessageResponse {
    content: Vec<AnthropicContentBlock>,
    usage: Option<AnthropicUsage>,
}

#[derive(Deserialize)]
struct AnthropicContentBlock {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

#[tauri::command]
pub fn bootstrap_local_recon(
    app: AppHandle,
    state: State<'_, LocalReconState>,
) -> Result<LocalReconBootstrap, String> {
    let hardware = build_hardware_profile();
    let recommended_model = recommend_model(&hardware).map_err(error_to_string)?;
    let models_path = local_recon_cache_dir(&app)
        .map(|path| display_path(&path))
        .unwrap_or_else(|_| "mistral.rs Hugging Face cache".to_string());
    let selected_model_ready = state
        .loaded_model_id()
        .map(|model_id| model_id == recommended_model.id)
        .unwrap_or(false)
        || model_marker_exists(&app, recommended_model.id);

    Ok(LocalReconBootstrap {
        supported_models: model_descriptors(recommended_model.id),
        provider_route: ProviderRoute {
            provider: "local-recon",
            base_url: EMBEDDED_MISTRAL_BASE_URL,
            model: recommended_model.id.to_string(),
            api_key_required: false,
            source: "local-engine",
        },
        local_runtime: LocalRuntimeState {
            engine: "mistral.rs",
            embedded: true,
            reachable: true,
            models_path,
            default_model: recommended_model.id.to_string(),
            recommended_model_id: recommended_model.id.to_string(),
            selected_model_ready,
            status: runtime_status(selected_model_ready, recommended_model),
        },
        recommended_model_id: recommended_model.id.to_string(),
        heavy_role_ram_threshold_gb: CLOUD_BRIDGE_RAM_GB,
        hardware,
    })
}

#[tauri::command]
pub async fn download_local_recon_model(
    app: AppHandle,
    state: State<'_, LocalReconState>,
    model_id: String,
) -> Result<LocalReconModelReady, String> {
    let profile = supported_model_by_id(&model_id)
        .ok_or_else(|| LocalReconError::UnsupportedModel(model_id.clone()))
        .map_err(error_to_string)?;
    let model = ensure_loaded_model(&state, &app, profile)
        .await
        .map_err(error_to_string)?;
    let cached = Arc::strong_count(&model) > 0;
    let models_path = local_recon_cache_dir(&app).map_err(error_to_string)?;

    Ok(LocalReconModelReady {
        model: profile.descriptor(true),
        cached,
        models_path: display_path(&models_path),
    })
}

#[tauri::command]
pub async fn distill_local_recon_prompt(
    app: AppHandle,
    state: State<'_, LocalReconState>,
    raw_intent: String,
    model_id: Option<String>,
) -> Result<LocalReconDistillation, String> {
    let raw_intent = raw_intent.trim().to_string();

    if raw_intent.is_empty() {
        return Err(error_to_string(LocalReconError::EmptyIntent));
    }

    let hardware = build_hardware_profile();
    let profile = match model_id.as_deref() {
        Some(id) if !id.trim().is_empty() => supported_model_by_id(id)
            .ok_or_else(|| LocalReconError::UnsupportedModel(id.to_string()))
            .map_err(error_to_string)?,
        _ => recommend_model(&hardware).map_err(error_to_string)?,
    };
    let model = ensure_loaded_model(&state, &app, profile)
        .await
        .map_err(error_to_string)?;
    let messages = TextMessages::new()
        .add_message(TextMessageRole::System, LOCAL_RECON_SYSTEM_PROMPT)
        .add_message(TextMessageRole::User, raw_intent.as_str());
    let response = model
        .send_chat_request(messages)
        .await
        .map_err(|source| LocalReconError::Inference(source.to_string()))
        .map_err(error_to_string)?;
    let distilled_output = response
        .choices
        .into_iter()
        .next()
        .and_then(|choice| choice.message.content)
        .map(|content| normalize_distilled_output(&content))
        .filter(|content| !content.is_empty())
        .ok_or(LocalReconError::MissingContent)
        .map_err(error_to_string)?;
    let raw_token_estimate = estimate_tokens(&raw_intent);
    let distilled_token_estimate = estimate_tokens(&distilled_output);

    Ok(LocalReconDistillation {
        raw_intent,
        distilled_output,
        raw_token_estimate,
        distilled_token_estimate,
        tokens_saved: raw_token_estimate.saturating_sub(distilled_token_estimate),
        model_id: profile.id.to_string(),
        model_label: profile.label.to_string(),
    })
}

#[tauri::command]
pub async fn dispatch_distilled_prompt(
    request: PaidDispatchRequest,
) -> Result<PaidDispatchResponse, String> {
    let prompt = request.prompt.trim().to_string();

    if prompt.is_empty() {
        return Err(error_to_string(LocalReconError::EmptyDistilledPrompt));
    }

    request
        .provider
        .client(request.api_key.trim())
        .map_err(LocalReconError::Dispatch)
        .map_err(error_to_string)?
        .dispatch(&prompt, request.model.trim())
        .await
        .map_err(LocalReconError::Dispatch)
        .map_err(error_to_string)
}

impl LocalReconState {
    fn loaded_model_id(&self) -> Result<Option<String>, LocalReconError> {
        self.loaded_model
            .lock()
            .map_err(|error| LocalReconError::State(error.to_string()))
            .map(|guard| guard.as_ref().map(|loaded| loaded.model_id.clone()))
    }
}

impl LocalModelProfile {
    fn descriptor(self, recommended: bool) -> LocalModelDescriptor {
        LocalModelDescriptor {
            id: self.id.to_string(),
            label: self.label.to_string(),
            repo_id: self.repo_id.to_string(),
            gguf_file: self.gguf_file.to_string(),
            tokenizer_repo: self.tokenizer_repo.to_string(),
            quantization: self.quantization.to_string(),
            context_window: self.context_window,
            min_ram_gb: self.min_ram_gb,
            recommended_vram_gb: self.recommended_vram_gb,
            estimated_size_gb: self.estimated_size_gb,
            tier: self.tier.to_string(),
            recommended,
        }
    }
}

impl PaidProvider {
    fn label(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::Anthropic => "Anthropic",
        }
    }

    fn client(
        self,
        api_key: &str,
    ) -> Result<Box<dyn PaidModelClient + Send + Sync>, ApiDispatchError> {
        if api_key.is_empty() {
            return Err(ApiDispatchError::MissingApiKey(self.label().to_string()));
        }

        let http = reqwest::Client::new();

        match self {
            Self::OpenAi => Ok(Box::new(OpenAiClient {
                http,
                api_key: api_key.to_string(),
                base_url: "https://api.openai.com/v1",
            })),
            Self::Anthropic => Ok(Box::new(AnthropicClient {
                http,
                api_key: api_key.to_string(),
                base_url: "https://api.anthropic.com/v1",
            })),
        }
    }
}

#[async_trait]
impl PaidModelClient for OpenAiClient {
    async fn dispatch(
        &self,
        prompt: &str,
        model: &str,
    ) -> Result<PaidDispatchResponse, ApiDispatchError> {
        if model.is_empty() {
            return Err(ApiDispatchError::MissingModel("OpenAI".to_string()));
        }

        let response = self
            .http
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&json!({
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                "temperature": 0.2
            }))
            .send()
            .await?;
        let status = response.status();

        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|error| format!("failed to read error body: {error}"));

            return Err(ApiDispatchError::Provider(format!(
                "OpenAI returned HTTP {status}: {body}"
            )));
        }

        let payload = response.json::<OpenAiChatResponse>().await?;
        let output = payload
            .choices
            .into_iter()
            .next()
            .and_then(|choice| choice.message.content)
            .filter(|content| !content.trim().is_empty())
            .ok_or(ApiDispatchError::MissingContent)?;
        let usage = payload.usage;

        Ok(PaidDispatchResponse {
            provider: "openai".to_string(),
            model: model.to_string(),
            output,
            input_tokens: usage.as_ref().and_then(|value| value.prompt_tokens),
            output_tokens: usage.as_ref().and_then(|value| value.completion_tokens),
            total_tokens: usage.and_then(|value| value.total_tokens),
        })
    }
}

#[async_trait]
impl PaidModelClient for AnthropicClient {
    async fn dispatch(
        &self,
        prompt: &str,
        model: &str,
    ) -> Result<PaidDispatchResponse, ApiDispatchError> {
        if model.is_empty() {
            return Err(ApiDispatchError::MissingModel("Anthropic".to_string()));
        }

        let response = self
            .http
            .post(format!("{}/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model,
                "max_tokens": 4096,
                "messages": [
                    {
                        "role": "user",
                        "content": prompt
                    }
                ]
            }))
            .send()
            .await?;
        let status = response.status();

        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|error| format!("failed to read error body: {error}"));

            return Err(ApiDispatchError::Provider(format!(
                "Anthropic returned HTTP {status}: {body}"
            )));
        }

        let payload = response.json::<AnthropicMessageResponse>().await?;
        let output = payload
            .content
            .into_iter()
            .filter(|block| block.kind == "text")
            .filter_map(|block| block.text)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();

        if output.is_empty() {
            return Err(ApiDispatchError::MissingContent);
        }

        let usage = payload.usage;
        let input_tokens = usage.as_ref().and_then(|value| value.input_tokens);
        let output_tokens = usage.as_ref().and_then(|value| value.output_tokens);
        let total_tokens = input_tokens
            .zip(output_tokens)
            .and_then(|(input, output)| input.checked_add(output));

        Ok(PaidDispatchResponse {
            provider: "anthropic".to_string(),
            model: model.to_string(),
            output,
            input_tokens,
            output_tokens,
            total_tokens,
        })
    }
}

async fn ensure_loaded_model(
    state: &LocalReconState,
    app: &AppHandle,
    profile: &LocalModelProfile,
) -> Result<Arc<mistralrs::Model>, LocalReconError> {
    if let Some(model) = state
        .loaded_model
        .lock()
        .map_err(|error| LocalReconError::State(error.to_string()))?
        .as_ref()
        .filter(|loaded| loaded.model_id == profile.id)
        .map(|loaded| Arc::clone(&loaded.model))
    {
        emit_progress(
            app,
            LocalReconProgress {
                model_id: profile.id.to_string(),
                phase: "ready",
                message: format!("{} is already loaded.", profile.label),
                progress: Some(1.0),
                cached: true,
            },
        );

        return Ok(model);
    }

    emit_progress(
        app,
        LocalReconProgress {
            model_id: profile.id.to_string(),
            phase: "resolving",
            message: format!("Resolving {} through mistral.rs.", profile.label),
            progress: Some(0.1),
            cached: model_marker_exists(app, profile.id),
        },
    );

    let builder = GgufModelBuilder::new(profile.repo_id, vec![profile.gguf_file])
        .with_tok_model_id(profile.tokenizer_repo)
        .with_logging();

    emit_progress(
        app,
            LocalReconProgress {
                model_id: profile.id.to_string(),
                phase: "loading",
                message: format!(
                    "Loading {}. mistral.rs will reuse cached weights when present.",
                    profile.label
                ),
                progress: Some(0.45),
                cached: model_marker_exists(app, profile.id),
            },
    );

    let model = builder
        .build()
        .await
        .map_err(|source| LocalReconError::ModelLoad {
            model_id: profile.id.to_string(),
            source: source.to_string(),
        })?;
    let model = Arc::new(model);

    {
        let mut loaded_model = state
            .loaded_model
            .lock()
            .map_err(|error| LocalReconError::State(error.to_string()))?;

        *loaded_model = Some(LoadedLocalModel {
            model_id: profile.id.to_string(),
            model: Arc::clone(&model),
        });
    }

    write_model_marker(app, profile)?;

    emit_progress(
        app,
        LocalReconProgress {
            model_id: profile.id.to_string(),
            phase: "ready",
            message: format!("{} is ready for Local Recon.", profile.label),
            progress: Some(1.0),
            cached: true,
        },
    );

    Ok(model)
}

fn recommend_model(hardware: &HardwareProfile) -> Result<&'static LocalModelProfile, LocalReconError> {
    let mut selected = SUPPORTED_LOCAL_MODELS.first().ok_or(LocalReconError::NoModels)?;

    for candidate in SUPPORTED_LOCAL_MODELS {
        if hardware_matches(candidate, hardware) {
            selected = candidate;
        }
    }

    Ok(selected)
}

fn hardware_matches(candidate: &LocalModelProfile, hardware: &HardwareProfile) -> bool {
    let ram_matches = hardware.total_ram_gb >= candidate.min_ram_gb;
    let vram_matches = candidate.recommended_vram_gb == 0
        || hardware.total_vram_gb == 0
        || hardware.total_vram_gb >= candidate.recommended_vram_gb;

    ram_matches && vram_matches
}

fn supported_model_by_id(model_id: &str) -> Option<&'static LocalModelProfile> {
    SUPPORTED_LOCAL_MODELS
        .iter()
        .find(|candidate| candidate.id == model_id)
}

fn model_descriptors(recommended_model_id: &str) -> Vec<LocalModelDescriptor> {
    SUPPORTED_LOCAL_MODELS
        .iter()
        .map(|profile| profile.descriptor(profile.id == recommended_model_id))
        .collect()
}

fn runtime_status(selected_model_ready: bool, model: &LocalModelProfile) -> String {
    if selected_model_ready {
        format!("Embedded mistral.rs is ready with {}.", model.label)
    } else {
        format!(
            "Embedded mistral.rs is available. {} will download on first use.",
            model.label
        )
    }
}

fn local_recon_cache_dir(app: &AppHandle) -> Result<PathBuf, LocalReconError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(LOCAL_RECON_CACHE_DIR))
        .map_err(|error| LocalReconError::AppDataDir(error.to_string()))
}

fn model_marker_path(app: &AppHandle, model_id: &str) -> Result<PathBuf, LocalReconError> {
    Ok(local_recon_cache_dir(app)?.join(format!("{model_id}.json")))
}

fn model_marker_exists(app: &AppHandle, model_id: &str) -> bool {
    model_marker_path(app, model_id)
        .map(|path| path.is_file())
        .unwrap_or(false)
}

fn write_model_marker(app: &AppHandle, profile: &LocalModelProfile) -> Result<(), LocalReconError> {
    let marker_path = model_marker_path(app, profile.id)?;
    let parent = marker_path
        .parent()
        .ok_or_else(|| {
            LocalReconError::AppDataDir("Local Recon marker path has no parent.".to_string())
        })?;

    fs::create_dir_all(parent).map_err(|source| LocalReconError::Io {
        action: "create Local Recon cache directory",
        path: display_path(parent),
        source,
    })?;

    let body = serde_json::to_string_pretty(&profile.descriptor(false))
        .map_err(|source| LocalReconError::State(source.to_string()))?;

    fs::write(&marker_path, format!("{body}\n")).map_err(|source| LocalReconError::Io {
        action: "write Local Recon model marker",
        path: display_path(&marker_path),
        source,
    })
}

fn emit_progress(app: &AppHandle, progress: LocalReconProgress) {
    let _ = app.emit(LOCAL_RECON_EVENT, progress);
}

fn normalize_distilled_output(output: &str) -> String {
    output
        .trim()
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .trim_matches('"')
        .trim()
        .to_string()
}

fn estimate_tokens(input: &str) -> u64 {
    let trimmed = input.trim();

    if trimmed.is_empty() {
        return 0;
    }

    let by_chars = ((trimmed.chars().count() as u64) + 3) / 4;
    let by_words = trimmed.split_whitespace().count() as u64;

    by_chars.max(by_words).max(1)
}

fn error_to_string(error: LocalReconError) -> String {
    error.to_string()
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
