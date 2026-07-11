import { invoke, isTauri } from "@tauri-apps/api/core";
import { createLocalRoute, type RuntimeRoute } from "./providerRouting";
import type { RoleName } from "./roles";

const DEFAULT_OLLAMA_API_BASE = "http://127.0.0.1:11434";
const DEFAULT_LIGHTWEIGHT_MODEL = "llama3.2:3b";
const DEFAULT_BALANCED_MODEL = "qwen2.5:7b";
const CLOUD_BRIDGE_RAM_THRESHOLD_GB = 32;

export type HardwareProfile = {
  readonly totalRamBytes: number;
  readonly totalRamGb: number;
  readonly ramSource: string;
  readonly tier: string;
  readonly defaultLocalModel: string;
  readonly cloudBridgeRecommendedBelowGb: number;
};

export type ProviderRouteState = {
  readonly provider: "ollama";
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyRequired: false;
  readonly source: "local-engine" | "browser-preview";
};

export type LocalRuntimeState = {
  readonly apiBase: string;
  readonly reachable: boolean;
  readonly version?: string | null;
  readonly launchedSidecar: boolean;
  readonly sidecarPid?: number | null;
  readonly sidecarError?: string | null;
  readonly modelsPath: string;
  readonly defaultModel: string;
  readonly defaultModelReady: boolean;
  readonly defaultModelPullStarted: boolean;
  readonly defaultModelError?: string | null;
  readonly status: string;
};

export type LocalEngineBootstrap = {
  readonly hardware: HardwareProfile;
  readonly providerRoute: ProviderRouteState;
  readonly localRuntime: LocalRuntimeState;
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
    ? await invoke<LocalEngineBootstrap>("bootstrap_local_engine")
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
  const version = await pingBrowserOllamaVersion();
  const hardware: HardwareProfile = {
    totalRamBytes: totalRamGb * 1024 * 1024 * 1024,
    totalRamGb,
    ramSource: totalRamGb > 0 ? "browser-device-memory" : "browser-preview-unknown",
    tier:
      totalRamGb === 0 || totalRamGb < 16
        ? "tier1-fallback"
        : totalRamGb < CLOUD_BRIDGE_RAM_THRESHOLD_GB
          ? "local-balanced"
          : "local-heavy",
    defaultLocalModel,
    cloudBridgeRecommendedBelowGb: CLOUD_BRIDGE_RAM_THRESHOLD_GB
  };

  return {
    hardware,
    providerRoute: {
      provider: "ollama",
      baseUrl: DEFAULT_OLLAMA_API_BASE,
      model: defaultLocalModel,
      apiKeyRequired: false,
      source: "browser-preview"
    },
    localRuntime: {
      apiBase: DEFAULT_OLLAMA_API_BASE,
      reachable: version !== null,
      version,
      launchedSidecar: false,
      sidecarPid: null,
      sidecarError: null,
      modelsPath: "desktop app data directory",
      defaultModel: defaultLocalModel,
      defaultModelReady: false,
      defaultModelPullStarted: false,
      defaultModelError: version
        ? null
        : "Browser preview cannot launch the desktop Ollama sidecar.",
      status: version
        ? `Browser preview connected to local Ollama ${version}.`
        : "Browser preview is active. Desktop launch manages the local engine."
    },
    heavyRoleRamThresholdGb: CLOUD_BRIDGE_RAM_THRESHOLD_GB
  };
}

function getBrowserRamEstimateGb(): number {
  const navigatorWithMemory = navigator as Navigator & {
    readonly deviceMemory?: number;
  };

  return Math.floor(navigatorWithMemory.deviceMemory ?? 0);
}

async function pingBrowserOllamaVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${DEFAULT_OLLAMA_API_BASE}/api/version`);

    if (response.status !== 200) {
      return null;
    }

    const payload = (await response.json()) as { readonly version?: string };

    return payload.version ?? "unknown";
  } catch {
    return null;
  }
}
