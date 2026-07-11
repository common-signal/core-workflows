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
  let listenerStarted = false;
  let unlistenProgress: UnlistenFn | null = null;

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
        statusTone = event.payload.phase === "ready" ? "success" : "idle";
        requestRender();
      });
    } catch (error) {
      listenerStarted = false;
      unlistenProgress = null;
      setStatus(formatError(error), "error");
    }
  };

  const prepareModel = async (modelId: string) => {
    if (isPreparing) {
      return;
    }

    if (!canInvokeTauri()) {
      setStatus("Desktop mode loads Local Recon models.", "idle");
      return;
    }

    isPreparing = true;
    setStatus("Preparing Local Recon model.");

    try {
      await startProgressListener();
      await invoke("download_local_recon_model", { modelId });
    } catch (error) {
      setStatus(formatError(error), "error");
    } finally {
      isPreparing = false;
      requestRender();
    }
  };

  const distill = async (modelId: string) => {
    if (isDistilling) {
      return;
    }

    if (!rawIntent.trim()) {
      setStatus("Raw intent is empty.", "error");
      return;
    }

    isDistilling = true;
    dispatchResponse = null;
    setStatus("Distilling raw intent locally.");

    try {
      await startProgressListener();
      const result = canInvokeTauri()
        ? await invoke<LocalReconDistillation>("distill_local_recon_prompt", {
            rawIntent,
            modelId
          })
        : distillInBrowserPreview(rawIntent, modelId, modelLabel(modelId));

      distillation = result;
      distilledOutput = result.distilledOutput;
      setStatus(`Distilled with ${result.modelLabel}.`, "success");
    } catch (error) {
      setStatus(formatError(error), "error");
    } finally {
      isDistilling = false;
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
        void prepareModel(selectedModel.id);
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
    }

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
        void distill(selectedModel.id);
      }
    });
    actions.append(distillAction);

    const dispatchPanel = buildDispatchPanel(dispatch);

    shell.append(header, statusRow, body, meta, actions, dispatchPanel);

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
  const distilledOutput = rawIntent
    .replace(/\b(please|just|really|basically|kind of|sort of)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
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
