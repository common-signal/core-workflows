import { invoke } from "@tauri-apps/api/core";
import logoUrl from "../assets/logo.png";
import { createLocalReconController } from "./LocalRecon";
import {
  bootstrapClientEngine,
  canInvokeTauri,
  type ClientEngineState
} from "./core/localEngine";
import {
  CLOUD_PROVIDERS,
  createCloudRoute,
  createLocalRoute,
  describeRoute,
  type CloudProviderId,
  type RuntimeRoute
} from "./core/providerRouting";
import {
  DEFAULT_ROLE,
  getRoleOption,
  ROLE_OPTIONS,
  shouldRecommendCloudBridge,
  type RoleName
} from "./core/roles";

type SaveResult =
  | {
      readonly mode: "desktop";
    }
  | {
      readonly mode: "browser-preview";
    };

type CloudBridgeModalState = {
  readonly role: RoleName;
  readonly provider: CloudProviderId;
  readonly apiKey: string;
  readonly error: string | null;
};

const BROWSER_PREVIEW_PROFILE_KEY = "common-signal.preview-archetype-profile";
const DEFAULT_LOCAL_ROUTE = createLocalRoute(
  "embedded://mistral.rs",
  "phi3-mini-4k-instruct-q4",
  DEFAULT_ROLE,
  "browser-preview"
);

export function renderOnboarding(root: HTMLElement): void {
  let selected: RoleName = DEFAULT_ROLE;
  let isSaving = false;
  let isBooting = true;
  let engineState: ClientEngineState | null = null;
  let route: RuntimeRoute = DEFAULT_LOCAL_ROUTE;
  let modalState: CloudBridgeModalState | null = null;
  let localOverrideRoles = new Set<RoleName>();
  let status = getInitialStatus();
  let statusTone: "idle" | "success" | "error" = "idle";

  const render = () => {
    root.replaceChildren(buildView());
  };
  const localRecon = createLocalReconController(render);

  const setStatus = (message: string, tone: "idle" | "success" | "error" = "idle") => {
    status = message;
    statusTone = tone;
    render();
  };

  const bootstrapEngine = async () => {
    isBooting = true;
    setStatus("Starting embedded Local Recon...");

    try {
      const nextEngineState = await bootstrapClientEngine(selected);
      engineState = nextEngineState;

      if (route.source !== "cloud-bridge") {
        route = createLocalRouteForRole(selected);
      }

      if (shouldOpenCloudBridge(selected)) {
        openCloudBridge(selected);
        return;
      }

      setStatus(formatBootStatus(nextEngineState), nextEngineState.localRuntime.reachable ? "success" : "idle");
    } catch (error) {
      setStatus(formatInvokeError(error), "error");
    } finally {
      isBooting = false;
      render();
    }
  };

  const saveSelection = async () => {
    if (isSaving) {
      return;
    }

    isSaving = true;
    setStatus(`Setting ${selected} as the active profile...`);

    try {
      const saveResult = await saveArchetypeProfile(selected, route);

      if (saveResult.mode === "browser-preview") {
        setStatus(`${selected} saved for this browser preview.`, "success");
        return;
      }

      setStatus(`${selected} is now active through ${route.label}.`, "success");
    } catch (error) {
      setStatus(formatInvokeError(error), "error");
    } finally {
      isSaving = false;
      render();
    }
  };

  const selectRole = (role: RoleName) => {
    selected = role;

    if (shouldOpenCloudBridge(role)) {
      openCloudBridge(role);
      render();
      return;
    }

    modalState = null;
    route = createLocalRouteForRole(role);
    statusTone = "idle";
    status = `${role} is ready through Local Recon with ${route.model}.`;
    render();
  };

  const refreshEngine = () => {
    void bootstrapEngine();
  };

  const openCloudBridge = (role: RoleName) => {
    modalState = {
      role,
      provider: preferredProviderForRole(role),
      apiKey: "",
      error: null
    };
    statusTone = "idle";
    status = `${role} can run locally, but Cloud Bridge is recommended for this hardware.`;
  };

  const updateCloudProvider = (provider: CloudProviderId) => {
    if (!modalState) {
      return;
    }

    modalState = {
      ...modalState,
      provider,
      error: null
    };
    render();
  };

  const updateCloudApiKey = (apiKey: string) => {
    if (!modalState) {
      return;
    }

    modalState = {
      ...modalState,
      apiKey,
      error: null
    };
  };

  const applyCloudBridge = () => {
    if (!modalState) {
      return;
    }

    const apiKey = modalState.apiKey.trim();

    if (!apiKey) {
      modalState = {
        ...modalState,
        error: "Paste a personal provider API key to bridge this role."
      };
      render();
      return;
    }

    route = createCloudRoute(modalState.provider, apiKey, modalState.role);
    selected = modalState.role;
    modalState = null;
    setStatus(`${selected} is bridged through ${route.label}.`, "success");
  };

  const overrideLocal = () => {
    if (!modalState) {
      return;
    }

    localOverrideRoles = new Set(localOverrideRoles).add(modalState.role);
    selected = modalState.role;
    route = createLocalRouteForRole(modalState.role);
    modalState = null;
    setStatus(`${selected} will run through Local Recon with ${route.model}.`, "idle");
  };

  const shouldOpenCloudBridge = (role: RoleName): boolean => {
    if (!engineState) {
      return false;
    }

    const totalRamGb = engineState.hardware.totalRamGb;

    return shouldRecommendCloudBridge(role, totalRamGb, localOverrideRoles.has(role));
  };

  const createLocalRouteForRole = (role: RoleName): RuntimeRoute => {
    const option = getRoleOption(role);
    const model =
      option.localModel === "engine-default"
        ? engineState?.hardware.defaultLocalModel ?? route.model
        : option.localModel;

    return createLocalRoute(
      engineState?.providerRoute.baseUrl ?? DEFAULT_LOCAL_ROUTE.baseUrl,
      model,
      role,
      engineState?.providerRoute.source ?? "browser-preview"
    );
  };

  const buildView = (): HTMLElement => {
    const shell = createElement("main", "app-shell");

    const header = createElement("header", "workspace-header");
    const brandBlock = createElement("div", "brand-block");
    const logoFrame = createElement("div", "logo-frame");
    const logo = createElement("img", "brand-logo") as HTMLImageElement;
    logo.src = logoUrl;
    logo.alt = "Common Signal logo";
    logo.width = 56;
    logo.height = 56;
    logoFrame.append(logo);

    const titleBlock = createElement("div", "title-block");
    const eyebrow = createElement("p", "eyebrow", "Common Signal");
    const title = createElement("h1", undefined, "Local Recon");
    const subtitle = createElement(
      "p",
      "subtitle",
      "Choose a role, distill raw intent locally, then dispatch only the lean payload when cloud reasoning is worth the spend."
    );
    titleBlock.append(eyebrow, title, subtitle);
    brandBlock.append(logoFrame, titleBlock);

    const statusPill = createElement("p", `status-pill ${statusTone}`, status);
    header.append(brandBlock, statusPill);

    const diagnostics = buildDiagnostics();
    const grid = createElement("section", "archetype-grid");
    grid.setAttribute("role", "radiogroup");
    grid.setAttribute("aria-label", "Common Signal role choices");

    for (const option of ROLE_OPTIONS) {
      grid.append(buildRoleButton(option.role));
    }

    const footer = createElement("footer", "action-bar");
    const activeLabel = createElement("p", "active-label", `Active route: ${selected}`);
    const actions = createElement("div", "actions");
    const refreshAction = createElement(
      "button",
      "secondary-action",
      isBooting ? "Starting..." : "Refresh Engine"
    );
    refreshAction.setAttribute("type", "button");
    refreshAction.disabled = isBooting;
    refreshAction.addEventListener("click", refreshEngine);
    const action = createElement(
      "button",
      "primary-action",
      isSaving ? "Applying..." : "Apply Profile"
    );
    action.setAttribute("type", "button");
    action.disabled = isSaving || isBooting;
    action.addEventListener("click", () => {
      void saveSelection();
    });
    actions.append(refreshAction, action);
    footer.append(activeLabel, actions);

    shell.append(header, diagnostics, localRecon.build(engineState), grid, footer);

    if (modalState) {
      shell.append(buildCloudBridgeModal(modalState));
    }

    return shell;
  };

  const buildDiagnostics = (): HTMLElement => {
    const diagnostics = createElement("section", "diagnostics");
    diagnostics.setAttribute("aria-label", "Local runtime diagnostics");
    diagnostics.append(
      buildDiagnosticItem("Hardware", formatHardware(engineState)),
      buildDiagnosticItem("Runtime", formatRuntime(engineState, isBooting)),
      buildDiagnosticItem("Route", describeRoute(route))
    );

    return diagnostics;
  };

  const buildDiagnosticItem = (label: string, value: string): HTMLElement => {
    const item = createElement("div", "diagnostic-item");
    item.append(
      createElement("p", "diagnostic-label", label),
      createElement("p", "diagnostic-value", value)
    );

    return item;
  };

  const buildRoleButton = (role: RoleName): HTMLButtonElement => {
    const option = getRoleOption(role);
    const button = createElement("button", "archetype-option") as HTMLButtonElement;
    const isSelected = option.role === selected;
    const cloudRecommended = shouldOpenCloudBridge(option.role);

    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(isSelected));
    button.dataset.selected = String(isSelected);
    button.dataset.cloudRecommended = String(cloudRecommended);
    button.addEventListener("click", () => selectRole(option.role));

    const name = createElement("span", "option-name", option.role);
    const description = createElement("span", "option-description", option.description);
    const signal = createElement(
      "span",
      "option-signal",
      cloudRecommended ? "Cloud Bridge recommended" : option.signal
    );

    button.append(name, description, signal);
    return button;
  };

  const buildCloudBridgeModal = (state: CloudBridgeModalState): HTMLElement => {
    const overlay = createElement("section", "modal-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Cloud Bridge");

    const modal = createElement("div", "cloud-modal");
    const title = createElement("h2", undefined, "Cloud Bridge");
    const copy = createElement(
      "p",
      "modal-copy",
      `The ${state.role} requires deep reasoning and a massive context window. To run this flawlessly without slowing down your computer, we recommend bridging to a cloud provider.`
    );

    const providerTabs = createElement("div", "provider-tabs");

    for (const provider of CLOUD_PROVIDERS) {
      const providerButton = createElement("button", "provider-tab", provider.label);
      providerButton.setAttribute("type", "button");
      providerButton.dataset.selected = String(provider.id === state.provider);
      providerButton.addEventListener("click", () => updateCloudProvider(provider.id));
      providerTabs.append(providerButton);
    }

    const selectedProvider = CLOUD_PROVIDERS.find((provider) => provider.id === state.provider);
    const input = createElement("input", "api-key-input") as HTMLInputElement;
    input.type = "password";
    input.value = state.apiKey;
    input.placeholder = selectedProvider?.apiKeyPlaceholder ?? "API key";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.addEventListener("input", (event) => {
      updateCloudApiKey((event.currentTarget as HTMLInputElement).value);
    });

    const error = state.error ? createElement("p", "modal-error", state.error) : null;
    const modalActions = createElement("div", "modal-actions");
    const bridgeAction = createElement("button", "primary-action", "Bridge Provider");
    bridgeAction.setAttribute("type", "button");
    bridgeAction.addEventListener("click", applyCloudBridge);
    const overrideAction = createElement(
      "button",
      "text-action",
      "Override and run locally anyway"
    );
    overrideAction.setAttribute("type", "button");
    overrideAction.addEventListener("click", overrideLocal);
    modalActions.append(bridgeAction, overrideAction);

    modal.append(title, copy, providerTabs, input);

    if (error) {
      modal.append(error);
    }

    modal.append(modalActions);
    overlay.append(modal);
    return overlay;
  };

  render();
  void bootstrapEngine();
}

function createElement<K extends keyof HTMLElementTagNameMap>(
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

function formatInvokeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Common Signal could not update the local profile.";
}

async function saveArchetypeProfile(
  role: RoleName,
  route: RuntimeRoute
): Promise<SaveResult> {
  if (canInvokeTauri()) {
    const updated = await invoke<boolean>("update_archetype_profile", {
      archetype: role
    });

    if (!updated) {
      throw new Error("The profile command completed without applying a change.");
    }

    return { mode: "desktop" };
  }

  saveBrowserPreviewProfile(role, route);
  return { mode: "browser-preview" };
}

function saveBrowserPreviewProfile(role: RoleName, route: RuntimeRoute): void {
  const previewState = {
    role,
    route: {
      provider: route.provider,
      baseUrl: route.baseUrl,
      model: route.model,
      source: route.source
    },
    updatedAt: new Date().toISOString(),
    source: "browser-preview"
  };

  window.localStorage.setItem(BROWSER_PREVIEW_PROFILE_KEY, JSON.stringify(previewState));
}

function getInitialStatus(): string {
  if (canInvokeTauri()) {
    return "Preparing embedded Local Recon.";
  }

  return "Browser preview is active. Desktop launch manages embedded Local Recon.";
}

function formatBootStatus(engineState: ClientEngineState): string {
  const runtime = engineState.localRuntime;

  if (runtime.selectedModelReady) {
    return `${runtime.status} ${runtime.defaultModel} is ready.`;
  }

  return runtime.status;
}

function formatHardware(engineState: ClientEngineState | null): string {
  if (!engineState) {
    return "Scanning RAM...";
  }

  const hardware = engineState.hardware;
  const ram = hardware.totalRamGb > 0 ? `${hardware.totalRamGb} GB RAM` : "RAM unknown";
  const vram = hardware.totalVramGb > 0 ? `, ${hardware.totalVramGb} GB VRAM` : "";

  return `${ram}${vram}, ${hardware.tier}, default ${hardware.defaultLocalModel}`;
}

function formatRuntime(engineState: ClientEngineState | null, isBooting: boolean): string {
  if (isBooting && !engineState) {
    return "Starting embedded runtime...";
  }

  if (!engineState) {
    return "Waiting for engine state.";
  }

  const runtime = engineState.localRuntime;

  if (runtime.selectedModelReady) {
    return `Embedded ${runtime.engine} ready with ${runtime.defaultModel}.`;
  }

  return runtime.status;
}

function preferredProviderForRole(role: RoleName): CloudProviderId {
  if (role === "Maintainer") {
    return "openai";
  }

  if (role === "Prototyper" || role === "Grower") {
    return "google";
  }

  return "anthropic";
}
