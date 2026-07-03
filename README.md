# Common Signal: Core AI Agent Workflows

> **The Common Signal Ethos:** We believe AI engineering power belongs to everyone. The future of development is model-agnostic, git-native, and immune to vendor platform lock-in. Common Signal provides the foundational, pre-configured agent architectures and workflow blueprints that enable developers to execute sophisticated multi-file refactoring, debugging, and review pipelines directly from their native environment. Free forever for individuals; extendable for enterprise scale.

---

## 🏗️ Core Architecture Matrix

Common Signal separates the **orchestration framework** from the **underlying LLM runtime**. Our template architecture is engineered to run seamlessly across distinct models and git providers without requiring file mutations.

| Model Pipeline | Optimized Engine Task | Execution Surface | Privacy Level |
| :--- | :--- | :--- | :--- |
| **Claude** | Complex multi-file refactoring, code understanding, architectural design | Terminal / Aider Architect | High (Bring-your-own-API) |
| **ChatGPT** | Structural refactoring, boilerplate generation, algorithm design | CLI Pipeline / Chat | High (Bring-your-own-API) |
| **Gemini** | High-context log analysis, full-codebase indexing, legacy-to-modern translation | Deep-Context Workflows | High (Bring-your-own-API) |
| **GitHub Copilot** | Fast inline autocompletions and routine tactical code generation | IDE Integration Layer | Managed Corporate Gateway |

---

## ⚡ Step 1: Initialize the Local Engine (Aider Setup)

Common Signal uses **Aider** as its git-native, terminal-first execution layer. Because Aider tracks all AI modifications as granular, reviewable git commits, it forms the perfect sandbox engine for executing code generation safely.

### 1. Pre-requisites & Installation
Ensure you are operating within a terminal environment with Python >= 3.9 and git configured. Install the core terminal engine:

```bash
python -m pip install aider-install
aider-install
```

### 2. Configure Your Environment Gateways
Common Signal relies entirely on a "Bring Your Own API Key" utility model. This ensures that no data passes through an unvetted central server. Create a local, git-ignored configuration file at the root of your working project:

```bash
# Inside your development workspace
touch .env
```

Add the target gateways you intend to run:
```ini
# Core Model API Gateways
ANTHROPIC_API_KEY=your_claude_key_here
OPENAI_API_KEY=your_chatgpt_key_here
GEMINI_API_KEY=your_gemini_key_here

# Enterprise Copilot Token Configuration (If applicable)
GITHUB_TOKEN=your_copilot_token_here
```

### 3. Kick off your First Session
Run your configuration framework using your model of choice. Common Signal agents are invoked by passing optimized model-routing flags directly to the engine:

```bash
# Launching with Claude (High-reasoning architecture)
aider --model sonnet

# Launching with ChatGPT
aider --model o3-mini

# Launching with Gemini for ultra-deep context windows
aider --model gemini/gemini-2.5-pro
```

---

## 🌐 Dual-Platform Synchronization (GitHub & GitLab)

Common Signal is designed to be fully decoupled from your specific cloud hosting git manager. The repository skeleton contains native parameters to execute continuous integration routines across both platforms.

### GitHub Environments
* Continuous integration and validation sequences live entirely within `.github/workflows/`.
* Secure keys are mapped using GitHub Secrets and passed safely into your local CLI runtime.

### GitLab Environments
* Platform configuration is automatically managed via `.gitlab-ci.yml` at the root directory.
* Custom, modular runtime pipeline components are maintained under `.gitlab/ci/` to allow seamless code-mirroring without pipeline collisions.

---

## 📂 Repository Layout

```text
├── .github/
│   └── workflows/            # GitHub Actions execution hooks
├── .gitlab/
│   └── ci/                   # Modular GitLab pipeline blocks
├── agents/                   # Pre-configured prompt & agent profiles
│   ├── chatgpt/              # OpenAI execution parameters
│   ├── claude/               # Anthropic structural refactoring blueprints
│   ├── copilot/              # Token refreshing and IDE routing rules
│   └── gemini/               # Deep context file-mapping blueprints
├── config/
│   └── signal.example.yaml   # Agnostic environment settings baseline
├── .gitlab-ci.yml            # Primary GitLab gatekeeper configuration
└── README.md                 # System Overview & Onboarding Blueprint
```