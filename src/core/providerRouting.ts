import type { RoleName } from "./roles";

export type RuntimeProvider = "ollama" | CloudProviderId;
export type CloudProviderId = "anthropic" | "openai" | "google";

export type CloudProviderOption = {
  readonly id: CloudProviderId;
  readonly label: string;
  readonly apiBaseUrl: string;
  readonly defaultModel: string;
  readonly apiKeyPlaceholder: string;
};

export type RuntimeRoute = {
  readonly provider: RuntimeProvider;
  readonly label: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly role: RoleName;
  readonly apiKeyRequired: boolean;
  readonly apiKey?: string;
  readonly source: "local-engine" | "cloud-bridge" | "browser-preview";
};

export const CLOUD_PROVIDERS: readonly CloudProviderOption[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    apiBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-3-5-sonnet-latest",
    apiKeyPlaceholder: "sk-ant-..."
  },
  {
    id: "openai",
    label: "OpenAI",
    apiBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    apiKeyPlaceholder: "sk-..."
  },
  {
    id: "google",
    label: "Google Gemini",
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-1.5-pro",
    apiKeyPlaceholder: "AIza..."
  }
];

export function createLocalRoute(
  baseUrl: string,
  model: string,
  role: RoleName,
  source: RuntimeRoute["source"] = "local-engine"
): RuntimeRoute {
  return {
    provider: "ollama",
    label: "Local Ollama",
    baseUrl,
    model,
    role,
    apiKeyRequired: false,
    source
  };
}

export function createCloudRoute(
  providerId: CloudProviderId,
  apiKey: string,
  role: RoleName
): RuntimeRoute {
  const provider = getCloudProvider(providerId);

  return {
    provider: provider.id,
    label: provider.label,
    baseUrl: provider.apiBaseUrl,
    model: provider.defaultModel,
    role,
    apiKeyRequired: true,
    apiKey,
    source: "cloud-bridge"
  };
}

export function getCloudProvider(providerId: CloudProviderId): CloudProviderOption {
  const provider = CLOUD_PROVIDERS.find((candidate) => candidate.id === providerId);

  if (!provider) {
    throw new Error(`Unsupported cloud provider: ${providerId}.`);
  }

  return provider;
}

export function describeRoute(route: RuntimeRoute): string {
  if (route.provider === "ollama") {
    return `Local: ${route.model} at ${route.baseUrl}`;
  }

  return `Cloud Bridge: ${route.label} using ${route.model}`;
}
