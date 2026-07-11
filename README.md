# Common Signal

Common Signal is a model-agnostic, git-native AI orchestration meta-framework. It treats the repository itself as the durable control plane: Issues capture intent, PRs capture proposed transitions, commits capture atomic state changes, and Markdown/YAML artifacts capture the routing metadata that agents need to collaborate without a proprietary orchestration database.

This repository is the v1.0.0-alpha core baseline. It provides documentation, CI routing templates, workspace configuration, and model-specific agent profiles that can be copied into an application repo or used as the source of truth for a shared agent operations workspace.

## Git As A State Machine

Common Signal models software work as a state machine whose state is visible in git.

| State Layer | Git-Native Artifact | Common Signal Role |
| --- | --- | --- |
| Intent | Issue, issue form, or webhook payload | Defines the requested change, archetype hint, attachments, and success criteria. |
| Routing | YAML frontmatter, labels, CI variables | Selects the archetype, model profile, risk level, token budget, and privacy controls. |
| Working State | Branch, draft PR, worktree | Contains agent-produced edits and local validation output. |
| Transition | Commit | Records an atomic state change with a reviewable diff. |
| Gate | CI job, status check, approval | Parses metadata, validates privacy constraints, checks tests, and decides whether work advances. |
| Memory | Markdown notes, PR discussion, generated specs | Preserves the reasoning trail without requiring hidden conversation state. |

The design goal is simple: every important orchestration decision should be recoverable from the repository timeline. A runner can fail, a model can change, or a vendor can disappear, and the project still retains its operational history through ordinary git objects and text files.

## Hybrid YAML And Markdown

Common Signal uses a hybrid file format:

- YAML is used for metadata, routing, safety boundaries, model selection, and deterministic machine parsing.
- Markdown is used for prompts, operator guidance, issue bodies, specs, and reviewable human context.

Agent profile files combine both. Each profile starts with YAML frontmatter, followed by a Markdown system prompt. CI jobs parse the frontmatter first, then pass the Markdown body to the selected model runtime only after privacy and token checks have completed.

## Archetype Onboarding Protocol

Common Signal uses the five system roles popularized by Boris Cherny as an onboarding vocabulary. A user does not need to know which model to pick first; they describe the shape of the work, and Common Signal maps that intent to an archetype.

| Archetype | Best For | Default Signal |
| --- | --- | --- |
| Prototyper | Exploring an idea, drafting a first pass, proving feasibility | "I need a quick version so we can see it." |
| Builder | Implementing planned features, making structural code changes, wiring tests | "The direction is known; now build it correctly." |
| Sweeper | Refactoring, cleanup, deduplication, migration, consistency passes | "This works, but it needs to be made clean." |
| Grower | Expanding a working system through specs, product surface, docs, and scaling paths | "This exists; help it mature." |
| Maintainer | Reliability, uptime, billing, MCP health, security posture, regression control | "Keep this stable and observable." |

The onboarding flow is intentionally lightweight:

1. Capture the request in an Issue, PR description, or local Markdown task.
2. Add YAML frontmatter when the requester already knows the route.
3. If no route is supplied, infer an archetype from the task language and labels.
4. Select the matching agent profile and model mapping from `config/signal.example.yaml`.
5. Run privacy scrubbing and token boundary checks before any model receives context.
6. Write outputs back to git as commits, PR comments, generated specs, or Markdown artifacts.

Example issue body:

```markdown
---
archetype: Builder
risk: medium
model_hint: claude
token_budget: 64000
privacy: pii-scrub-required
---

Implement account-level audit event export and add regression coverage.
```

## Model Routing Matrix

| Runtime | Default Profile | Primary Strength | Typical Surface |
| --- | --- | --- | --- |
| Claude | `agents/claude/builder-profile.md` | Deep deterministic logic, refactoring, multi-file implementation | Terminal runner, CI worker, local worktree |
| ChatGPT | `agents/chatgpt/maintainer-profile.md` | Operational checks, structured analysis, stability review | ChatOps, scheduled CI, incident triage |
| Copilot | `agents/copilot/ide-routing.md` | IDE indexing, inline edits, developer workflow feedback | Editor extension, token gateway, workspace index |
| Gemini | `agents/gemini/context-indexer.md` | Ultra-long-context logs, broad codebase matching, draft specs | Indexing job, analysis runner, spec compiler |

The mapping is configurable. The example workspace defaults live in `config/signal.example.yaml` and intentionally separate model identity from archetype identity, so teams can change providers without rewriting prompt content.

## CI Orchestration

The repository includes provider-native entry points for GitHub and GitLab.

- `.github/workflows/triage-routing.yml` listens for opened issues and pull request activity. It parses YAML frontmatter from Markdown bodies, creates a sanitized attachment manifest, and passes local file paths and event metadata to a Common Signal runner.
- `.gitlab-ci.yml` is the root gatekeeper for pushes, merge requests, API-triggered issue events, and manual routing tests.
- `.gitlab/ci/triage-step.yml` provides the modular GitLab parsing job that mirrors the GitHub workflow shape.

The CI templates do not execute uploaded files. They isolate attachment references into JSON manifests so a local runner can decide whether and how to retrieve them under the workspace privacy policy.

## Local Setup

Create a local config from the example:

```bash
cp config/signal.example.yaml config/signal.local.yaml
```

Set provider credentials in your local environment or CI secret store:

```ini
ANTHROPIC_API_KEY=your_claude_key_here
OPENAI_API_KEY=your_openai_key_here
GEMINI_API_KEY=your_gemini_key_here
GITHUB_TOKEN=your_github_token_here
HUBSPOT_PRIVATE_APP_TOKEN=your_hubspot_token_here
```

Run a dry route by passing the files created by CI to the runner:

```bash
common-signal triage route \
  --provider github \
  --event issues.opened \
  --frontmatter .common-signal/runtime/frontmatter.json \
  --attachments .common-signal/runtime/attachments.json \
  --workspace .
```

If `common-signal` is not installed yet, the provided CI templates print the resolved arguments so the pipeline remains testable during early adoption.

## Local Desktop Client

This repository includes an early Tauri v2 desktop client. The client is a lightweight local control plane for selecting a Common Signal archetype and, when launched through Tauri, writing local profile state back into the workspace.

Install JavaScript dependencies:

```bash
npm install
```

On Windows PowerShell, use `npm.cmd` if script execution policy blocks the `npm` shim:

```powershell
npm.cmd install
```

Run the browser preview:

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:1420/
```

The browser preview is useful for checking the TypeScript UI. Because it is not running inside the Tauri shell, profile saves are stored in browser `localStorage` only.

Run the desktop shell:

```bash
npm run desktop:dev
```

The desktop command requires the Rust toolchain. Verify Rust is available before launching Tauri:

```bash
cargo --version
rustc --version
rustup --version
```

If any of those commands fail, install Rust with `rustup`, then close and reopen your terminal before trying again.

### Install Rust On Windows

1. Open the official Rust installer page:

   ```text
   https://www.rust-lang.org/tools/install
   ```

2. Download and run `rustup-init.exe`.

3. Accept the default install option when prompted.

4. If the installer asks for Visual Studio C++ Build Tools, install them. Choose the C++ desktop build tools workload when Visual Studio Installer opens.

5. Close PowerShell, open a new PowerShell window, then verify:

   ```powershell
   rustup --version
   rustc --version
   cargo --version
   ```

6. From this repository, run:

   ```powershell
   npm.cmd run desktop:dev
   ```

### Install Rust On macOS

1. Open Terminal and run:

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. Accept the default install option when prompted.

3. Close Terminal, open a new Terminal window, then verify:

   ```bash
   rustup --version
   rustc --version
   cargo --version
   ```

4. From this repository, run:

   ```bash
   npm run desktop:dev
   ```

If verification still fails after reopening the terminal, make sure Rust's cargo binary directory is on `PATH`. On Windows it is usually `%USERPROFILE%\.cargo\bin`; on macOS it is usually `$HOME/.cargo/bin`.

If PowerShell says `rustc` or `cargo` is not recognized, run this check:

```powershell
Test-Path "$env:USERPROFILE\.cargo\bin\rustc.exe"
Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe"
```

If both return `False`, Rust is not installed yet. Run the Windows installer above. If they return `True`, Rust is installed but your current terminal does not have the cargo directory on `PATH`. Close every PowerShell and VS Code terminal, open a new PowerShell window, and try the version checks again. For a temporary fix in the current PowerShell window:

```powershell
$env:Path += ";$env:USERPROFILE\.cargo\bin"
rustc --version
cargo --version
```

In desktop mode, selecting an archetype and clicking `Apply Profile` invokes the Rust command `update_archetype_profile` and writes local state to:

```text
.common-signal/local/archetype-profile.json
```

The desktop backend also includes Local Recon commands backed by embedded `mistral.rs`. The backend recommends a GGUF model from local RAM/VRAM, loads the model without an external daemon, distills raw intent, and can dispatch the approved distilled prompt to a configured paid provider.

The local recon defaults are configurable through `config/signal.local.yaml`. If that file is not present, Common Signal falls back to `config/signal.example.yaml`.

```yaml
local_runtime:
  local_recon:
    engine: mistral.rs
    cache_dir: .common-signal/runtime/local-recon-models
    distillation_model: phi3-mini-4k-instruct-q4
    dispatch_provider: openai
```

Build checks:

```bash
npm run build
npm run desktop:build
```

`npm run build` validates the TypeScript/Vite frontend. `npm run desktop:build` validates and packages the full Tauri app, and also requires Rust/Cargo.

The `package-lock.json` file is intentionally committed. It pins the npm dependency graph for the Tauri/Vite client so contributors and CI install the same package versions.

## Local Recon

Common Signal uses Local Recon to compress messy human intent before a paid model ever sees it. The desktop app loads a quantized GGUF model through embedded `mistral.rs`, applies the built-in distillation system prompt, shows raw/distilled token estimates, and dispatches only the approved distilled payload.

Override the default Local Recon settings by creating `config/signal.local.yaml` and changing `local_runtime.local_recon`:

```yaml
local_runtime:
  local_recon:
    engine: mistral.rs
    cache_dir: .common-signal/runtime/local-recon-models
    distillation_model: llama3-8b-instruct-q4
    dispatch_provider: anthropic
```

### Hugging Face Token

Local Recon downloads GGUF model weights through the Hugging Face Hub. Public models may work without a token, but a token is recommended and gated models require one. Hugging Face calls this a User Access Token; for local model downloads, use a `read` token or a fine-grained token with read access to the model.

Create the token:

1. Go to:

   ```text
   https://huggingface.co/settings/tokens
   ```

2. Click `New token`.

3. Choose `read`, or choose `fine-grained` and grant read access to the model repositories you plan to use.

4. Copy the token. It will look like `hf_...`.

Set it for the current PowerShell window:

```powershell
$env:HF_TOKEN = "hf_your_token_here"
npm.cmd run desktop:dev
```

Set it permanently on Windows:

```powershell
[Environment]::SetEnvironmentVariable("HF_TOKEN", "hf_your_token_here", "User")
```

After setting it permanently, close every PowerShell and VS Code terminal, then open a fresh terminal and verify:

```powershell
$env:HF_TOKEN
```

Set it for the current macOS Terminal window:

```bash
export HF_TOKEN="hf_your_token_here"
npm run desktop:dev
```

Set it permanently on macOS:

```bash
echo 'export HF_TOKEN="hf_your_token_here"' >> ~/.zshrc
source ~/.zshrc
```

If a model is gated, also open the model page in your browser while logged into Hugging Face and accept its access terms before clicking `Prepare Model`.

### Local Recon Smoke Test

Paste this into `Raw Intent`:

```text
Hey, could you please just help me with something? I'm kind of stuck and I need you to update the Tauri backend so it validates the YAML config file and shows any parsing errors in the UI. Please make it clean and maybe format the answer nicely. Thanks!
```

Click `Distill`. A good result should look close to:

```text
Update the Tauri backend to validate the YAML config file and display parsing errors in the UI.
```

The exact wording can vary by model, but the distilled output should be shorter, technical, and free of the greeting, uncertainty, thanks, and formatting chatter.

## Repository Layout

```text
.
|-- src/
|   |-- LocalRecon.ts
|   |-- Onboarding.ts
|   |-- main.ts
|   `-- styles.css
|-- src-tauri/
|   |-- capabilities/
|   |   `-- default.json
|   |-- src/
|   |   |-- hardware.rs
|   |   |-- lib.rs
|   |   |-- local_recon.rs
|   |   `-- main.rs
|   |-- build.rs
|   |-- Cargo.toml
|   `-- tauri.conf.json
|-- .github/
|   `-- workflows/
|       `-- triage-routing.yml
|-- .gitlab/
|   `-- ci/
|       `-- triage-step.yml
|-- agents/
|   |-- chatgpt/
|   |   `-- maintainer-profile.md
|   |-- claude/
|   |   `-- builder-profile.md
|   |-- copilot/
|   |   `-- ide-routing.md
|   `-- gemini/
|       `-- context-indexer.md
|-- config/
|   `-- signal.example.yaml
|-- .gitlab-ci.yml
|-- index.html
|-- llms.txt
|-- package.json
|-- package-lock.json
`-- README.md
```

## Status

This is an alpha foundation. The core contract is stable enough to test routing, parse profile frontmatter, and wire provider-specific runners, but downstream teams should still version their local profiles and configs separately before production rollout.
