import { invoke, isTauri } from "@tauri-apps/api/core";
import { createLocalRoute, type RuntimeRoute } from "./providerRouting";
import type { RoleName } from "./roles";

const EMBEDDED_MISTRAL_BASE_URL = "embedded://mistral.rs";
const DEFAULT_LIGHTWEIGHT_MODEL = "phi3-mini-4k-instruct-q4";
const DEFAULT_BALANCED_MODEL = "llama3-8b-instruct-q4";
const CLOUD_BRIDGE_RAM_THRESHOLD_GB = 32;

export type HardwareProfile = {
  readonly totalRamBytes: number;
  readonly totalRamGb: number;
  readonly ramSource: string;
  readonly totalVramBytes: number;
  readonly totalVramGb: number;
  readonly vramSource: string;
  readonly tier: string;
  readonly defaultLocalModel: string;
  readonly recommendedLocalReconModelId: string;
  readonly cloudBridgeRecommendedBelowGb: number;
};

export type SupportedLocalModel = {
  readonly id: string;
  readonly label: string;
  readonly repoId: string;
  readonly ggufFile: string;
  readonly tokenizerRepo: string;
  readonly quantization: string;
  readonly contextWindow: number;
  readonly minRamGb: number;
  readonly recommendedVramGb: number;
  readonly estimatedSizeGb: number;
  readonly tier: string;
  readonly recommended: boolean;
};

export type ProviderRouteState = {
  readonly provider: "local-recon";
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyRequired: false;
  readonly source: "local-engine" | "browser-preview";
};

export type LocalRuntimeState = {
  readonly engine: "mistral.rs";
  readonly embedded: boolean;
  readonly reachable: boolean;
  readonly modelsPath: string;
  readonly defaultModel: string;
  readonly recommendedModelId: string;
  readonly selectedModelReady: boolean;
  readonly status: string;
};

export type LocalEngineBootstrap = {
  readonly hardware: HardwareProfile;
  readonly providerRoute: ProviderRouteState;
  readonly localRuntime: LocalRuntimeState;
  readonly supportedModels: readonly SupportedLocalModel[];
  readonly recommendedModelId: string;
  readonly heavyRoleRamThresholdGb: number;
};

export type ClientEngineState = LocalEngineBootstrap & {
  readonly route: RuntimeRoute;
};

type TauriRuntimeWindow = Window &
  typeof globalThis & {
    readonly __TAURI_INTERNALS__?: {
      readonly invoke?: unknown;
    };
  };

export async function bootstrapClientEngine(defaultRole: RoleName): Promise<ClientEngineState> {
  const bootstrap = canInvokeTauri()
    ? await invoke<LocalEngineBootstrap>("bootstrap_local_recon")
    : await bootstrapBrowserPreview();

  return {
    ...bootstrap,
    route: createLocalRoute(
      bootstrap.providerRoute.baseUrl,
      bootstrap.providerRoute.model,
      defaultRole,
      bootstrap.providerRoute.source
    )
  };
}

export function canInvokeTauri(): boolean {
  const runtimeWindow = window as TauriRuntimeWindow;

  return isTauri() && typeof runtimeWindow.__TAURI_INTERNALS__?.invoke === "function";
}

async function bootstrapBrowserPreview(): Promise<LocalEngineBootstrap> {
  const totalRamGb = getBrowserRamEstimateGb();
  const defaultLocalModel =
    totalRamGb >= 16 ? DEFAULT_BALANCED_MODEL : DEFAULT_LIGHTWEIGHT_MODEL;
  const hardware: HardwareProfile = {
    totalRamBytes: totalRamGb * 1024 * 1024 * 1024,
    totalRamGb,
    ramSource: totalRamGb > 0 ? "browser-device-memory" : "browser-preview-unknown",
    totalVramBytes: 0,
    totalVramGb: 0,
    vramSource: "browser-preview-unknown",
    tier:
      totalRamGb === 0 || totalRamGb < 16
        ? "tier1-fallback"
        : totalRamGb < CLOUD_BRIDGE_RAM_THRESHOLD_GB
          ? "local-balanced"
          : "local-heavy",
    defaultLocalModel,
    recommendedLocalReconModelId: defaultLocalModel,
    cloudBridgeRecommendedBelowGb: CLOUD_BRIDGE_RAM_THRESHOLD_GB
  };

  return {
    hardware,
    providerRoute: {
      provider: "local-recon",
      baseUrl: EMBEDDED_MISTRAL_BASE_URL,
      model: defaultLocalModel,
      apiKeyRequired: false,
      source: "browser-preview"
    },
    localRuntime: {
      engine: "mistral.rs",
      embedded: false,
      reachable: false,
      modelsPath: "desktop app data directory",
      defaultModel: defaultLocalModel,
      recommendedModelId: defaultLocalModel,
      selectedModelReady: false,
      status: "Browser preview is active. Desktop mode loads embedded mistral.rs."
    },
    supportedModels: browserSupportedModels(defaultLocalModel),
    recommendedModelId: defaultLocalModel,
    heavyRoleRamThresholdGb: CLOUD_BRIDGE_RAM_THRESHOLD_GB
  };
}

function browserSupportedModels(recommendedModelId: string): readonly SupportedLocalModel[] {
  return [
    {
      id: "phi3-mini-4k-instruct-q4",
      label: "Phi-3 Mini 4K Instruct Q4",
      repoId: "microsoft/Phi-3-mini-4k-instruct-gguf",
      ggufFile: "Phi-3-mini-4k-instruct-q4.gguf",
      tokenizerRepo: "microsoft/Phi-3-mini-4k-instruct",
      quantization: "Q4",
      contextWindow: 4096,
      minRamGb: 8,
      recommendedVramGb: 0,
      estimatedSizeGb: 2.4,
      tier: "low-end",
      recommended: recommendedModelId === "phi3-mini-4k-instruct-q4"
    },
    {
      id: "llama3-8b-instruct-q4",
      label: "Llama 3 8B Instruct Q4_K_M",
      repoId: "bartowski/Meta-Llama-3-8B-Instruct-GGUF",
      ggufFile: "Meta-Llama-3-8B-Instruct-Q4_K_M.gguf",
      tokenizerRepo: "meta-llama/Meta-Llama-3-8B-Instruct",
      quantization: "Q4_K_M",
      contextWindow: 8192,
      minRamGb: 16,
      recommendedVramGb: 6,
      estimatedSizeGb: 4.9,
      tier: "mid-tier",
      recommended: recommendedModelId === "llama3-8b-instruct-q4"
    },
    {
      id: "qwen25-coder-7b-instruct-q4",
      label: "Qwen2.5 Coder 7B Instruct Q4_K_M",
      repoId: "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
      ggufFile: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
      tokenizerRepo: "Qwen/Qwen2.5-Coder-7B-Instruct",
      quantization: "Q4_K_M",
      contextWindow: 32768,
      minRamGb: 24,
      recommendedVramGb: 8,
      estimatedSizeGb: 4.7,
      tier: "technical",
      recommended: recommendedModelId === "qwen25-coder-7b-instruct-q4"
    }
  ];
}

function getBrowserRamEstimateGb(): number {
  const navigatorWithMemory = navigator as Navigator & {
    readonly deviceMemory?: number;
  };

  return Math.floor(navigatorWithMemory.deviceMemory ?? 0);
}
