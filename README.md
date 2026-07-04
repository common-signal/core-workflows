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

## Repository Layout

```text
.
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
|-- llms.txt
`-- README.md
```

## Status

This is an alpha foundation. The core contract is stable enough to test routing, parse profile frontmatter, and wire provider-specific runners, but downstream teams should still version their local profiles and configs separately before production rollout.
