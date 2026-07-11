# Bundled Ollama Sidecar

Place the platform-specific Ollama executable for desktop bundles in this folder:

- Windows: `ollama.exe`
- macOS/Linux: `ollama`

At launch, Common Signal first pings the global Ollama service at
`http://127.0.0.1:11434/api/version`. If it is not reachable, the desktop app
starts this bundled binary with `ollama serve` and sets `OLLAMA_MODELS` to the
app-local user data directory.

For local development without committing a binary, set `COMMON_SIGNAL_OLLAMA_BIN`
to an installed Ollama executable.
