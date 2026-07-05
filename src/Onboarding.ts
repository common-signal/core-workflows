import { invoke, isTauri } from "@tauri-apps/api/core";

type Archetype = "Prototyper" | "Builder" | "Sweeper" | "Grower" | "Maintainer";

type ArchetypeOption = {
  readonly archetype: Archetype;
  readonly description: string;
  readonly signal: string;
};

const ARCHETYPES: readonly ArchetypeOption[] = [
  {
    archetype: "Prototyper",
    description: "Explore a first pass, test feasibility, and make the idea visible.",
    signal: "Quick version, clear learning."
  },
  {
    archetype: "Builder",
    description: "Implement planned work, wire structure, and keep behavior testable.",
    signal: "Known direction, careful execution."
  },
  {
    archetype: "Sweeper",
    description: "Clean, migrate, deduplicate, and make the system easier to change.",
    signal: "Working system, cleaner shape."
  },
  {
    archetype: "Grower",
    description: "Expand a working foundation through product surface, docs, and scale paths.",
    signal: "Existing seed, stronger surface."
  },
  {
    archetype: "Maintainer",
    description: "Protect reliability, security posture, operating checks, and regressions.",
    signal: "Stable baseline, visible health."
  }
];

const DEFAULT_ARCHETYPE: Archetype = "Builder";
const BROWSER_PREVIEW_PROFILE_KEY = "common-signal.preview-archetype-profile";

type SaveResult =
  | {
      readonly mode: "desktop";
    }
  | {
      readonly mode: "browser-preview";
    };

type TauriRuntimeWindow = Window &
  typeof globalThis & {
    readonly __TAURI_INTERNALS__?: {
      readonly invoke?: unknown;
    };
  };

export function renderOnboarding(root: HTMLElement): void {
  let selected: Archetype = DEFAULT_ARCHETYPE;
  let isSaving = false;
  let status = getInitialStatus();
  let statusTone: "idle" | "success" | "error" = "idle";

  const render = () => {
    root.replaceChildren(buildView());
  };

  const setStatus = (message: string, tone: "idle" | "success" | "error" = "idle") => {
    status = message;
    statusTone = tone;
    render();
  };

  const saveSelection = async () => {
    if (isSaving) {
      return;
    }

    isSaving = true;
    setStatus(`Setting ${selected} as the active profile...`);

    try {
      const saveResult = await saveArchetypeProfile(selected);

      if (saveResult.mode === "browser-preview") {
        setStatus(`${selected} saved for this browser preview.`, "success");
        return;
      }

      setStatus(`${selected} is now the active local profile.`, "success");
    } catch (error) {
      setStatus(formatInvokeError(error), "error");
    } finally {
      isSaving = false;
      render();
    }
  };

  const selectArchetype = (archetype: Archetype) => {
    selected = archetype;
    statusTone = "idle";
    status = `${archetype} is ready to apply.`;
    render();
  };

  const buildView = (): HTMLElement => {
    const shell = createElement("main", "app-shell");

    const header = createElement("header", "workspace-header");
    const titleBlock = createElement("div", "title-block");
    const eyebrow = createElement("p", "eyebrow", "Common Signal");
    const title = createElement("h1", undefined, "Archetype Onboarding");
    const subtitle = createElement(
      "p",
      "subtitle",
      "Pick the work profile that best matches this local workspace session."
    );
    titleBlock.append(eyebrow, title, subtitle);

    const statusPill = createElement("p", `status-pill ${statusTone}`, status);
    header.append(titleBlock, statusPill);

    const grid = createElement("section", "archetype-grid");
    grid.setAttribute("role", "radiogroup");
    grid.setAttribute("aria-label", "Archetype choices");

    for (const option of ARCHETYPES) {
      grid.append(buildArchetypeButton(option));
    }

    const footer = createElement("footer", "action-bar");
    const activeLabel = createElement("p", "active-label", `Active selection: ${selected}`);
    const action = createElement(
      "button",
      "primary-action",
      isSaving ? "Applying..." : "Apply Profile"
    );
    action.setAttribute("type", "button");
    action.disabled = isSaving;
    action.addEventListener("click", () => {
      void saveSelection();
    });
    footer.append(activeLabel, action);

    shell.append(header, grid, footer);
    return shell;
  };

  const buildArchetypeButton = (option: ArchetypeOption): HTMLButtonElement => {
    const button = createElement("button", "archetype-option") as HTMLButtonElement;
    const isSelected = option.archetype === selected;

    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(isSelected));
    button.dataset.selected = String(isSelected);
    button.addEventListener("click", () => selectArchetype(option.archetype));

    const name = createElement("span", "option-name", option.archetype);
    const description = createElement("span", "option-description", option.description);
    const signal = createElement("span", "option-signal", option.signal);

    button.append(name, description, signal);
    return button;
  };

  render();
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

async function saveArchetypeProfile(archetype: Archetype): Promise<SaveResult> {
  if (canInvokeTauri()) {
    const updated = await invoke<boolean>("update_archetype_profile", {
      archetype
    });

    if (!updated) {
      throw new Error("The profile command completed without applying a change.");
    }

    return { mode: "desktop" };
  }

  saveBrowserPreviewProfile(archetype);
  return { mode: "browser-preview" };
}

function canInvokeTauri(): boolean {
  const runtimeWindow = window as TauriRuntimeWindow;

  return isTauri() && typeof runtimeWindow.__TAURI_INTERNALS__?.invoke === "function";
}

function saveBrowserPreviewProfile(archetype: Archetype): void {
  const previewState = {
    archetype,
    updatedAt: new Date().toISOString(),
    source: "browser-preview"
  };

  window.localStorage.setItem(BROWSER_PREVIEW_PROFILE_KEY, JSON.stringify(previewState));
}

function getInitialStatus(): string {
  if (canInvokeTauri()) {
    return "Select an archetype to set the local Common Signal profile.";
  }

  return "Browser preview is active. Desktop save uses the Tauri shell.";
}
