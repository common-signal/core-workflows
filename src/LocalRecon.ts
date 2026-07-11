import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { canInvokeTauri, type ClientEngineState, type SupportedLocalModel } from "./core/localEngine";
import { CLOUD_PROVIDERS, type CloudProviderId } from "./core/providerRouting";

type LocalReconProgress = {
  readonly modelId: string;
  readonly phase: string;
  readonly message: string;
  readonly progress?: number | null;
  readonly cached: boolean;
};

type LocalReconDistillation = {
  readonly rawIntent: string;
  readonly distilledOutput: string;
  readonly rawTokenEstimate: number;
  readonly distilledTokenEstimate: number;
  readonly tokensSaved: number;
  readonly modelId: string;
  readonly modelLabel: string;
};

type PaidDispatchResponse = {
  readonly provider: "openai" | "anthropic";
  readonly model: string;
  readonly output: string;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly totalTokens?: number | null;
};

type PaidProvider = Extract<CloudProviderId, "openai" | "anthropic">;

type LocalReconActivity = {
  readonly kind: "prepare" | "distill" | "dispatch";
  readonly label: string;
  readonly modelId: string | null;
};

type LocalReconController = {
  readonly build: (engineState: ClientEngineState | null) => HTMLElement;
};

const LOCAL_RECON_EVENT = "local-recon://download-progress";
const PAID_PROVIDERS = CLOUD_PROVIDERS.filter(
  (provider): provider is (typeof CLOUD_PROVIDERS)[number] & { readonly id: PaidProvider } =>
    provider.id === "openai" || provider.id === "anthropic"
);

export function createLocalReconController(requestRender: () => void): LocalReconController {
  let rawIntent = "";
  let distilledOutput = "";
  let selectedModelId: string | null = null;
  let distillation: LocalReconDistillation | null = null;
  let progress: LocalReconProgress | null = null;
  let status = "Local Recon is standing by.";
  let statusTone: "idle" | "success" | "error" = "idle";
  let paidProvider: PaidProvider = "openai";
  let paidModel = defaultCloudModel(paidProvider);
  let apiKey = "";
  let dispatchResponse: PaidDispatchResponse | null = null;
  let isPreparing = false;
  let isDistilling = false;
  let isDispatching = false;
  let activeActivity: LocalReconActivity | null = null;
  let listenerStarted = false;
  let unlistenProgress: UnlistenFn | null = null;

  const beginActivity = (
    kind: LocalReconActivity["kind"],
    label: string,
    modelId: string | null
  ) => {
    activeActivity = { kind, label, modelId };
  };

  const finishActivity = () => {
    activeActivity = null;
  };

  const setStatus = (message: string, tone: "idle" | "success" | "error" = "idle") => {
    status = message;
    statusTone = tone;
    requestRender();
  };

  const startProgressListener = async () => {
    if (listenerStarted || !canInvokeTauri()) {
      return;
    }

    listenerStarted = true;

    try {
      unlistenProgress = await listen<LocalReconProgress>(LOCAL_RECON_EVENT, (event) => {
        progress = event.payload;
        status = event.payload.message;
        statusTone =
          (event.payload.phase === "ready" && !isDistilling) ||
          event.payload.phase === "complete"
            ? "success"
            : "idle";
        requestRender();
      });
    } catch (error) {
      listenerStarted = false;
      unlistenProgress = null;
      setStatus(formatError(error), "error");
    }
  };

  const prepareModel = async (modelId: string, label = modelLabel(modelId)) => {
    if (isPreparing) {
      return;
    }

    if (!canInvokeTauri()) {
      setStatus("Desktop mode loads Local Recon models.", "idle");
      return;
    }

    isPreparing = true;
    beginActivity("prepare", label, modelId);
    progress = {
      modelId,
      phase: "resolving",
      message: `Checking local files for ${label}.`,
      progress: null,
      cached: false
    };
    setStatus("Preparing Local Recon model.");

    try {
      await startProgressListener();
      await invoke("download_local_recon_model", { modelId });
      setStatus(`${label} is ready for Local Recon.`, "success");
    } catch (error) {
      setStatus(formatError(error), "error");
    } finally {
      isPreparing = false;
      finishActivity();
      requestRender();
    }
  };

  const distill = async (modelId: string, label = modelLabel(modelId)) => {
    if (isDistilling) {
      return;
    }

    if (!rawIntent.trim()) {
      setStatus("Raw intent is empty.", "error");
      return;
    }

    isDistilling = true;
    dispatchResponse = null;
    beginActivity("distill", label, modelId);
    progress = {
      modelId,
      phase: "distill-start",
      message: `Starting local distillation with ${label}.`,
      progress: null,
      cached: false
    };
    setStatus("Distilling raw intent locally.");

    try {
      await startProgressListener();
      const isDesktop = canInvokeTauri();
      const result = isDesktop
        ? await invoke<LocalReconDistillation>("distill_local_recon_prompt", {
            rawIntent,
            modelId
          })
        : distillInBrowserPreview(rawIntent, modelId, label);

      distillation = result;
      distilledOutput = result.distilledOutput;
      setStatus(
        isDesktop
          ? `Distilled with ${result.modelLabel}.`
          : "Preview distillation complete. Desktop mode uses embedded mistral.rs.",
        "success"
      );
    } catch (error) {
      setStatus(formatError(error), "error");
    } finally {
      isDistilling = false;
      finishActivity();
      requestRender();
    }
  };

  const dispatch = async () => {
    if (isDispatching) {
      return;
    }

    if (!distilledOutput.trim()) {
      setStatus("Distilled output is empty.", "error");
      return;
    }

    if (!apiKey.trim()) {
      setStatus(`${providerLabel(paidProvider)} API key is required.`, "error");
      return;
    }

    if (!canInvokeTauri()) {
      setStatus("Desktop mode dispatches paid provider requests.", "idle");
      return;
    }

    isDispatching = true;
    beginActivity("dispatch", providerLabel(paidProvider), null);
    setStatus(`Dispatching to ${providerLabel(paidProvider)}.`);

    try {
      dispatchResponse = await invoke<PaidDispatchResponse>("dispatch_distilled_prompt", {
        request: {
          provider: paidProvider,
          apiKey,
          model: paidModel,
          prompt: distilledOutput
        }
      });
      setStatus(`Dispatched to ${providerLabel(paidProvider)}.`, "success");
    } catch (error) {
      setStatus(formatError(error), "error");
    } finally {
      isDispatching = false;
      finishActivity();
      requestRender();
    }
  };

  const build = (engineState: ClientEngineState | null): HTMLElement => {
    void startProgressListener();

    const models = engineState?.supportedModels ?? [];
    const modelId = selectedModelId ?? engineState?.recommendedModelId ?? models[0]?.id ?? "";
    const selectedModel = models.find((model) => model.id === modelId) ?? models[0] ?? null;
    const shell = el("section", "local-recon");
    shell.setAttribute("aria-label", "Local Recon prompt distillation");

    const header = el("div", "local-recon-header");
    const titleBlock = el("div", "local-recon-title");
    titleBlock.append(el("p", "eyebrow", "Local Recon"), el("h2", undefined, "Prompt Distillation"));

    const modelControls = el("div", "model-controls");
    const modelSelect = el("select", "model-select") as HTMLSelectElement;
    modelSelect.setAttribute("aria-label", "Local Recon model");
    modelSelect.disabled = models.length === 0;

    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.recommended ? `${model.label} (recommended)` : model.label;
      option.selected = model.id === modelId;
      modelSelect.append(option);
    }

    modelSelect.addEventListener("change", (event) => {
      selectedModelId = (event.currentTarget as HTMLSelectElement).value;
      progress = null;
      requestRender();
    });

    const prepareAction = el(
      "button",
      "secondary-action compact-action",
      isPreparing ? "Preparing..." : "Prepare Model"
    ) as HTMLButtonElement;
    prepareAction.type = "button";
    prepareAction.disabled = isPreparing || !selectedModel;
    prepareAction.addEventListener("click", () => {
      if (selectedModel) {
        void prepareModel(selectedModel.id, selectedModel.label);
      }
    });

    modelControls.append(modelSelect, prepareAction);
    header.append(titleBlock, modelControls);

    const statusRow = el("div", "local-recon-status");
    statusRow.dataset.tone = statusTone;
    statusRow.append(el("p", "status-text", status));

    if (progress?.progress !== undefined && progress.progress !== null) {
      const meter = el("div", "progress-track");
      const fill = el("span", "progress-fill") as HTMLSpanElement;
      fill.style.width = `${Math.round(progress.progress * 100)}%`;
      meter.append(fill);
      statusRow.append(meter);
    } else if (activeActivity) {
      const meter = el("div", "progress-track progress-track-indeterminate");
      meter.append(el("span", "progress-fill"));
      statusRow.append(meter);
    }

    const activityPanel = activeActivity
      ? buildActivityPanel(activeActivity, progress, status)
      : null;

    const body = el("div", "recon-body");
    const rawField = buildTextPanel(
      "Raw Intent",
      rawIntent,
      "raw-intent-input",
      false,
      (value) => {
        rawIntent = value;
        distillation = null;
      }
    );
    const distilledField = buildTextPanel(
      "Distilled Output",
      distilledOutput,
      "distilled-output-input",
      false,
      (value) => {
        distilledOutput = value;
        distillation = {
          rawIntent,
          distilledOutput: value,
          rawTokenEstimate: estimateTokens(rawIntent),
          distilledTokenEstimate: estimateTokens(value),
          tokensSaved: Math.max(estimateTokens(rawIntent) - estimateTokens(value), 0),
          modelId,
          modelLabel: selectedModel?.label ?? modelId
        };
      }
    );
    body.append(rawField, distilledField);

    const savings = currentSavings(distillation, rawIntent, distilledOutput);
    const meta = el("div", "recon-meta");
    meta.append(
      buildMetric("Raw intent", `${savings.raw} tokens`),
      buildMetric("Distilled", `${savings.distilled} tokens`),
      buildMetric("Tokens saved", `${savings.saved} tokens`),
      buildMetric("Model", selectedModel ? modelSummary(selectedModel) : "No model")
    );

    const actions = el("div", "recon-actions");
    const distillAction = el(
      "button",
      "primary-action",
      isDistilling ? "Distilling..." : "Distill"
    ) as HTMLButtonElement;
    distillAction.type = "button";
    distillAction.disabled = isDistilling || !selectedModel;
    distillAction.addEventListener("click", () => {
      if (selectedModel) {
        void distill(selectedModel.id, selectedModel.label);
      }
    });
    actions.append(distillAction);

    const dispatchPanel = buildDispatchPanel(dispatch);

    shell.append(header, statusRow);

    if (activityPanel) {
      shell.append(activityPanel);
    }

    shell.append(body, meta, actions, dispatchPanel);

    if (dispatchResponse) {
      shell.append(buildDispatchResponse(dispatchResponse));
    }

    return shell;
  };

  window.addEventListener("beforeunload", () => {
    if (unlistenProgress) {
      unlistenProgress();
    }
  });

  return { build };

  function buildDispatchPanel(onDispatch: () => void): HTMLElement {
    const panel = el("div", "dispatch-panel");
    const providerSelect = el("select", "provider-select") as HTMLSelectElement;
    providerSelect.setAttribute("aria-label", "Dispatch provider");

    for (const provider of PAID_PROVIDERS) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      option.selected = provider.id === paidProvider;
      providerSelect.append(option);
    }

    providerSelect.addEventListener("change", (event) => {
      paidProvider = (event.currentTarget as HTMLSelectElement).value as PaidProvider;
      paidModel = defaultCloudModel(paidProvider);
      requestRender();
    });

    const modelInput = el("input", "dispatch-model-input") as HTMLInputElement;
    modelInput.type = "text";
    modelInput.value = paidModel;
    modelInput.setAttribute("aria-label", "Paid model");
    modelInput.addEventListener("input", (event) => {
      paidModel = (event.currentTarget as HTMLInputElement).value;
    });

    const keyInput = el("input", "dispatch-key-input") as HTMLInputElement;
    keyInput.type = "password";
    keyInput.value = apiKey;
    keyInput.placeholder = providerPlaceholder(paidProvider);
    keyInput.autocomplete = "off";
    keyInput.spellcheck = false;
    keyInput.setAttribute("aria-label", `${providerLabel(paidProvider)} API key`);
    keyInput.addEventListener("input", (event) => {
      apiKey = (event.currentTarget as HTMLInputElement).value;
    });

    const dispatchAction = el(
      "button",
      "primary-action dispatch-action",
      isDispatching ? "Dispatching..." : "Dispatch"
    ) as HTMLButtonElement;
    dispatchAction.type = "button";
    dispatchAction.disabled = isDispatching || !distilledOutput.trim();
    dispatchAction.addEventListener("click", () => onDispatch());

    panel.append(providerSelect, modelInput, keyInput, dispatchAction);
    return panel;
  }
}

function buildTextPanel(
  label: string,
  value: string,
  id: string,
  readonly: boolean,
  onInput: (value: string) => void
): HTMLElement {
  const panel = el("label", "text-panel");
  const labelText = el("span", "field-label", label);
  const textarea = el("textarea", "recon-textarea") as HTMLTextAreaElement;
  textarea.id = id;
  textarea.value = value;
  textarea.readOnly = readonly;
  textarea.spellcheck = true;
  textarea.addEventListener("input", (event) => {
    onInput((event.currentTarget as HTMLTextAreaElement).value);
  });
  panel.append(labelText, textarea);

  return panel;
}

function buildMetric(label: string, value: string): HTMLElement {
  const metric = el("div", "recon-metric");
  metric.append(el("span", "metric-label", label), el("strong", "metric-value", value));

  return metric;
}

function buildActivityPanel(
  activity: LocalReconActivity,
  progress: LocalReconProgress | null,
  fallbackMessage: string
): HTMLElement {
  const phase = progress?.phase ?? fallbackPhase(activity.kind);
  const stages = activityStages(activity.kind);
  const activeIndex = activeStageIndex(activity.kind, stages, phase);
  const panel = el("section", "recon-activity");
  panel.setAttribute("aria-live", "polite");

  const header = el("div", "activity-header");
  const spinner = el("span", "activity-spinner");
  spinner.setAttribute("aria-hidden", "true");

  const heading = el("div", "activity-heading");
  heading.append(
    el("strong", "activity-title", activityTitle(activity.kind)),
    el("p", "activity-message", progress?.message ?? fallbackMessage)
  );
  header.append(spinner, heading);

  const details = el("div", "activity-details");
  details.append(
    buildActivityDetail(activity.kind === "dispatch" ? "Target" : "Model", activity.label),
    buildActivityDetail("Phase", phaseLabel(phase))
  );

  if (activity.kind !== "dispatch") {
    details.append(buildActivityDetail("Cache", cacheLabel(progress)));
  }

  const steps = el("ol", "activity-steps");

  stages.forEach((stage, index) => {
    const item = el("li", "activity-step");
    item.dataset.state = stepState(index, activeIndex, phase);
    item.append(el("span", "step-marker"), el("span", "step-label", stage.label));
    steps.append(item);
  });

  panel.append(header, details, steps);

  return panel;
}

function buildActivityDetail(label: string, value: string): HTMLElement {
  const detail = el("p", "activity-detail");
  detail.append(el("span", "activity-detail-label", label), el("strong", undefined, value));

  return detail;
}

function buildDispatchResponse(response: PaidDispatchResponse): HTMLElement {
  const panel = el("section", "dispatch-response");
  const header = el(
    "p",
    "dispatch-response-title",
    `${providerLabel(response.provider)} / ${response.model}`
  );
  const output = el("pre", "dispatch-output", response.output);
  const usage = el(
    "p",
    "dispatch-usage",
    response.totalTokens !== undefined && response.totalTokens !== null
      ? `Provider tokens: ${response.totalTokens}`
      : "Provider tokens unavailable"
  );
  panel.append(header, output, usage);

  return panel;
}

type ActivityStage = {
  readonly label: string;
  readonly phases: readonly string[];
};

function activityStages(kind: LocalReconActivity["kind"]): readonly ActivityStage[] {
  if (kind === "prepare") {
    return [
      { label: "Check local model files", phases: ["resolving"] },
      { label: "Load model through mistral.rs", phases: ["loading"] },
      { label: "Ready model for use", phases: ["ready", "complete"] }
    ];
  }

  if (kind === "distill") {
    return [
      { label: "Check model cache", phases: ["distill-start", "resolving"] },
      { label: "Load or reuse weights", phases: ["loading"] },
      { label: "Run local inference", phases: ["ready", "generating"] },
      { label: "Clean distilled output", phases: ["finalizing", "complete"] }
    ];
  }

  return [{ label: "Await provider response", phases: ["dispatching"] }];
}

function activeStageIndex(
  kind: LocalReconActivity["kind"],
  stages: readonly ActivityStage[],
  phase: string
): number {
  if (kind === "distill" && phase === "ready") {
    return Math.max(
      stages.findIndex((stage) => stage.phases.includes("generating")),
      0
    );
  }

  const index = stages.findIndex((stage) => stage.phases.includes(phase));

  return index >= 0 ? index : 0;
}

function stepState(index: number, activeIndex: number, phase: string): "pending" | "active" | "done" {
  if (phase === "complete" || index < activeIndex) {
    return "done";
  }

  if (index === activeIndex) {
    return "active";
  }

  return "pending";
}

function fallbackPhase(kind: LocalReconActivity["kind"]): string {
  if (kind === "prepare") {
    return "resolving";
  }

  if (kind === "distill") {
    return "distill-start";
  }

  return "dispatching";
}

function activityTitle(kind: LocalReconActivity["kind"]): string {
  if (kind === "prepare") {
    return "Preparing model";
  }

  if (kind === "distill") {
    return "Distillation running";
  }

  return "Dispatch running";
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    "distill-start": "Preparing",
    resolving: "Resolving files",
    loading: "Loading model",
    ready: "Model ready",
    generating: "Local inference",
    finalizing: "Finalizing",
    complete: "Complete",
    dispatching: "Dispatching"
  };

  return labels[phase] ?? phase;
}

function cacheLabel(progress: LocalReconProgress | null): string {
  if (!progress) {
    return "Checking";
  }

  if (progress.cached) {
    return "Using cached files";
  }

  return "May download on first use";
}

function currentSavings(
  distillation: LocalReconDistillation | null,
  rawIntent: string,
  distilledOutput: string
): { readonly raw: number; readonly distilled: number; readonly saved: number } {
  if (distillation) {
    return {
      raw: distillation.rawTokenEstimate,
      distilled: distillation.distilledTokenEstimate,
      saved: distillation.tokensSaved
    };
  }

  const raw = estimateTokens(rawIntent);
  const distilled = estimateTokens(distilledOutput);

  return {
    raw,
    distilled,
    saved: Math.max(raw - distilled, 0)
  };
}

function distillInBrowserPreview(
  rawIntent: string,
  modelId: string,
  label: string
): LocalReconDistillation {
  const distilledOutput = distillHeuristically(rawIntent);
  const rawTokenEstimate = estimateTokens(rawIntent);
  const distilledTokenEstimate = estimateTokens(distilledOutput);

  return {
    rawIntent,
    distilledOutput,
    rawTokenEstimate,
    distilledTokenEstimate,
    tokensSaved: Math.max(rawTokenEstimate - distilledTokenEstimate, 0),
    modelId,
    modelLabel: label
  };
}

function distillHeuristically(rawIntent: string): string {
  const strippedLines = rawIntent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isNonIntentLine(line))
    .map(stripMarkdownPrefix)
    .map(stripConversationalLead)
    .map(stripFillerWords)
    .join(" ");
  const collapsed = strippedLines.replace(/\s+/g, " ").trim();
  const sentence = selectTechnicalSentence(collapsed);

  return sentence || collapsed || rawIntent.trim();
}

function isNonIntentLine(line: string): boolean {
  const normalized = line.toLowerCase();

  return (
    normalized === "thanks" ||
    normalized === "thank you" ||
    normalized.startsWith("thanks ") ||
    normalized.startsWith("thank you") ||
    normalized.startsWith("sorry ") ||
    normalized.startsWith("i'm sorry") ||
    normalized.startsWith("im sorry") ||
    normalized.startsWith("tone:") ||
    normalized.startsWith("format:") ||
    normalized.startsWith("formatting:") ||
    normalized.startsWith("output format:")
  );
}

function stripMarkdownPrefix(line: string): string {
  return line
    .replace(/^`{3,}/, "")
    .replace(/`{3,}$/, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/^\s*>\s?/, "")
    .trim();
}

function stripConversationalLead(line: string): string {
  return line
    .replace(/^(can|could|would)\s+you\s+/i, "")
    .replace(/^i\s+(need|want|would like)\s+(you\s+)?to\s+/i, "")
    .replace(/^help\s+me\s+/i, "")
    .replace(/^we\s+need\s+to\s+/i, "")
    .replace(/^the\s+task\s+is\s+to\s+/i, "")
    .replace(/^my\s+request\s+is\s+to\s+/i, "")
    .trim();
}

function stripFillerWords(line: string): string {
  return line
    .replace(
      /\b(please|kindly|just|really|basically|honestly|literally|maybe|probably|sort of|kind of|if possible|when you get a chance)\b/gi,
      ""
    )
    .replace(/\b(make sure to|be careful to|i think|i feel like)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function selectTechnicalSentence(value: string): string {
  const sentences = value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    return value;
  }

  const technical = sentences.filter((sentence) =>
    /\b(add|build|create|fix|implement|refactor|remove|replace|update|wire|test|debug|migrate|backend|frontend|api|rust|tauri|component|model|prompt|token|cache|download|dispatch|ui)\b/i.test(
      sentence
    )
  );

  return (technical.length > 0 ? technical : sentences).join(" ");
}

function estimateTokens(value: string): number {
  const trimmed = value.trim();

  if (!trimmed) {
    return 0;
  }

  return Math.max(Math.ceil(trimmed.length / 4), trimmed.split(/\s+/).length, 1);
}

function modelSummary(model: SupportedLocalModel): string {
  const vram =
    model.recommendedVramGb > 0 ? `, ${model.recommendedVramGb} GB VRAM` : "";

  return `${model.quantization}, ${model.minRamGb} GB RAM${vram}`;
}

function defaultCloudModel(providerId: PaidProvider): string {
  return CLOUD_PROVIDERS.find((provider) => provider.id === providerId)?.defaultModel ?? "gpt-4o";
}

function providerLabel(providerId: PaidProvider): string {
  return CLOUD_PROVIDERS.find((provider) => provider.id === providerId)?.label ?? providerId;
}

function providerPlaceholder(providerId: PaidProvider): string {
  return CLOUD_PROVIDERS.find((provider) => provider.id === providerId)?.apiKeyPlaceholder ?? "API key";
}

function modelLabel(modelId: string): string {
  return modelId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Local Recon could not complete the request.";
}

function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  textContent?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  if (textContent !== undefined) {
    element.textContent = textContent;
  }

  return element;
}
