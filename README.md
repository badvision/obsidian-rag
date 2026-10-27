# Obsidian RAG

Local retrieval-augmented generation (RAG) for [Obsidian](https://obsidian.md). Ask questions about your vault — PDFs and Markdown notes — with a local or CLI LLM and a local embedding model. Embeddings stay on your machine; no data leaves it.

Supports [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), or **self-hosted local ONNX models** for embeddings, and Ollama, LM Studio, or **any one-shot LLM CLI** (OpenCode, OMP, or your own command) for chat.

---

## Features

- Semantic search over PDFs and Markdown notes
- Section-aware chunking that preserves heading context
- Streaming answers with inline citations
- Embeddings run fully locally — the index never leaves your machine. Chat can be local or routed through a CLI whose model you already trust.

---

## Installation

This plugin is not yet in the Obsidian community plugin directory. Install it manually:

### Option A — Pre-packaged zip (includes self-hosted ONNX support; recommended)

1. Download the zip for your platform from the [latest release](../../releases/latest): `obsidian-rag-v1.0.0-darwin-arm64.zip` (macOS, Apple Silicon) or `obsidian-rag-v1.0.0-win-x64.zip` (Windows, 64-bit).
2. Unzip it directly into your vault's `.obsidian/plugins/` folder — the archive already contains the `obsidian-rag/` plugin folder, including the `node_modules` the self-hosted ONNX provider needs.
3. Open Obsidian → **Settings → Community plugins** → turn off Safe Mode if prompted → enable **Obsidian RAG**.

Each package ships the ONNX runtime native binding for its own platform (built in CI on that OS/architecture). If you only use Ollama or LM Studio (no ONNX), the three-file Option B works on any platform. On other OS/architectures with ONNX (e.g. Linux), use Option C and run `npm install` in the plugin folder.

### Option B — Three files (Ollama / LM Studio providers only)

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest).
2. In your vault, create the folder `.obsidian/plugins/obsidian-rag/`.
3. Copy the three files into that folder.
4. Open Obsidian → **Settings → Community plugins** → turn off Safe Mode if prompted → enable **Obsidian RAG**.

Without `node_modules` in the plugin folder, the **Self-hosted ONNX** embedding provider is unavailable — Ollama and LM Studio work normally.

### Option C — Build from source

```bash
git clone https://github.com/badvision/obsidian-rag.git
cd obsidian-rag
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/obsidian-rag/` folder (a symlink also works) and enable the plugin as above. The plugin folder's `node_modules` makes the self-hosted ONNX provider available on any platform after `npm install`.

---

## Prerequisites

You need an **embedding provider** with an embedding model — a running local server (Ollama or LM Studio), or **none at all**: the self-hosted ONNX option runs a small embedding model in a managed local worker (downloaded once, then fully offline). The **chat** model can come from the same local server *or* from a one-shot LLM CLI you already use (OpenCode, OMP, …), so you can chat through a cloud model your CLI is configured with while embeddings stay local.

For Ollama or LM Studio, start the server and install an embedding model before configuring Obsidian RAG. The ONNX provider instead downloads its selected model on first use.

### Ollama (recommended)

1. Install from [ollama.com](https://ollama.com) and start it. Ollama runs as a background service on `http://localhost:11434`.
2. Pull a chat model and an embedding model:

```bash
# Chat model — generates the answers
ollama pull llama3.2

# Embedding model — powers the semantic index
ollama pull nomic-embed-text
```

Both models must be pulled before you index your vault or ask questions.

### LM Studio / MLX

1. Install from [lmstudio.ai](https://lmstudio.ai).
2. Open LM Studio, go to the **Discover** tab, and download a chat model and an embedding model.
3. Go to the **Local Server** tab, load both models, and click **Start Server** (default: `http://localhost:1234`).

The server must be running with both models loaded before you index your vault or ask questions.

### Self-hosted ONNX (no server)

No Ollama, no LM Studio — the plugin manages a local embedding worker using [transformers.js](https://huggingface.co/docs/transformers.js) and ONNX Runtime. Native inference runs in a separate Electron utility process, not Obsidian's renderer. No external server or Node installation is required.

1. In Settings → Obsidian RAG, choose **Managed local ONNX worker (no server)** for the Embedding Provider.
2. Pick a model — curated picks include `all-MiniLM-L6-v2` (384d, fastest), `all-mpnet-base-v2` (768d, strong), `bge-small-en-v1.5` (384d), `paraphrase-multilingual-MiniLM-L12-v2` (384d, multilingual), and `nomic-embed-text-v1.5` int8 (768d — same model family as LM Studio/Ollama nomic). Any Hugging Face repo with an ONNX export works too.
3. Click **Test Connection**. The model downloads on first use and is cached in the plugin folder (`models/`) — afterwards it needs no network or separately managed server.

Desktop only: the plugin directory must contain `node_modules` with `@huggingface/transformers` and `onnxruntime-node` — the pre-packaged release zips already include them (macOS Apple Silicon and Windows x64). The worker resolves dependencies from the installed plugin path; load failures retain the original dependency error. Existing models in Obsidian's browser cache are copied to the filesystem cache without downloading them again.

CPU is the default. The CPU memory arena is disabled to avoid its large retained allocations. Optional **CoreML** uses Apple's GPU/ANE and falls back to CPU if unsupported. An indexing run reuses one model worker; the worker is disposed after the run. Query embedding also releases its worker before answer generation.

---

## Configuration

Open **Settings → Obsidian RAG** after enabling the plugin.

### Providers

The embedding and chat roles are configured **independently** — you can embed locally and chat through a CLI (or vice versa).

**Embeddings** — *Ollama*, *LM Studio / MLX*, or *Self-hosted ONNX* (no server; model runs in a managed worker, downloaded once and cached in the plugin folder). Server providers each have their own Base URL (default `http://localhost:11434` / `http://localhost:1234`) and an optional API key (sent as a `Bearer` token, for remote endpoints that require auth).

**Chat** — *Ollama*, *LM Studio / MLX*, or *CLI*.

#### CLI chat provider

Run any one-shot LLM CLI and feed the RAG conversation into it. The command line is a **template** you own — presets are just starting points:

| Preset | Starting template |
|---|---|
| **OpenCode** | `opencode run --format json --dir {tmpdir} {prompt}` |
| **OMP** | `omp -p --mode json --no-session {prompt}` |
| **Custom** | `{prompt}` (blank — build your own) |

Tokens available in the template:

| Token | Value |
|---|---|
| `{prompt}` | The full RAG conversation (system prompt + retrieved context + question) as one argument |
| `{system}` | Just the system prompt (e.g. for a `--system-prompt` flag) |
| `{question}` | Just the user's current question |
| `{tmpdir}` | A fresh throwaway working directory, so the CLI never starts in your vault |

You can add any flags the tool supports — model selection, agents, etc. For example: `omp -p --mode json --no-session --model gpt-5 {prompt}`.

> **PATH note:** Obsidian launched from the Dock on macOS has a minimal PATH. The plugin auto-detects OpenCode/OMP in common locations (`~/.opencode/bin`, `/opt/homebrew/bin`, `~/.local/bin`, …) and writes the absolute path into the template. If your CLI lives elsewhere, paste its full path into the template.

The **Test Connection** button runs a real round-trip through the template (a minimal prompt with a known expected reply) and shows the parsed response, so you can confirm your command is wired correctly before asking real questions.

Under **Index Management**, **Re-index** sits beside **Clear** and runs the same indexing flow as **RAG: Index all files**, with progress notices and unchanged-file skipping. For a full rebuild, clear the index first, then re-index.

### LLM model vs. embedding model

The plugin uses **two separate models** that serve different purposes:

**Chat model (LLM)** — Generates your answers. It reads the retrieved chunks and synthesises a response in natural language. This is the model you'd think of as "the AI" — e.g. `llama3.2`, `mistral`, `phi4`. A larger, more capable model gives better answers but is slower.

**Embedding model** — Converts text into a list of numbers (a vector) that captures its meaning. When you index your vault, every chunk is embedded. When you ask a question, it is also embedded, and the closest chunk vectors are retrieved. The embedding model never generates text — it only needs to be good at representing meaning numerically. Dedicated embedding models like `nomic-embed-text` or `mxbai-embed-large` are much smaller and faster than chat models. **Important:** changing the embedding model requires a full re-index, because old vectors are incompatible with the new model's space.

Recommended pairings:

| Use case | Chat model | Embedding model |
|---|---|---|
| Fast / low-RAM | `llama3.2` (3B) | `nomic-embed-text` |
| Balanced | `mistral` (7B) | `nomic-embed-text` |
| High quality | `phi4` (14B) | `mxbai-embed-large` |

Use the **Test Connection** button to verify both roles before indexing: it probes the embedding provider (and reports the vector dimension) and the chat provider — for a CLI, a full round-trip with the parsed reply shown.

### Retrieval

**Top K Results** controls how many document chunks are fetched from the index and handed to the LLM for each query. This is the most impactful tuning knob after model selection.

| Vault size / query type | Recommended Top K |
|---|---|
| Small vault (< 50 files) or narrow factual questions | 5 – 10 |
| Medium vault or mixed note types | 10 – 20 (default: 20) |
| Large vault (hundreds of files) or broad/synthesis questions | 25 – 40 |

**Raising Top K** gives the LLM more evidence to draw from — useful when the answer might be spread across many notes or when you ask comparative / summary questions. The trade-off is that the LLM's context window fills faster, answers take longer, and weaker models may lose focus with too much context.

**Lowering Top K** produces faster, more focused answers and works well for specific factual lookups where you know the answer lives in one or two chunks.

Chunk size also matters: if you raise `Chunk Size` significantly (e.g. to 1000+ tokens), reduce Top K accordingly to avoid overflowing the LLM's context window.

### Indexing

| Setting | Description |
|---|---|
| **Index Scope** | *PDFs and Markdown notes* (default) or *PDFs only*. |
| **Chunk Size** | Approximate token count per chunk (default 500). Larger chunks preserve more context per piece; smaller chunks improve retrieval precision. |
| **Auto-index on Startup** | Queue a startup refresh and track changed files. Automatic indexing waits for three minutes without relevant vault or chat activity. |

The index is stored at `.obsidian/plugins/obsidian-rag/index/index.gcf` using [GCF](https://www.gcformat.com/). Table fields are declared once rather than repeated for every chunk. Each chunk retains its source, text and citation metadata; its vector is encoded as little-endian IEEE-754 **Float64**, losslessly DEFLATE-compressed and base64-encoded. No dimensions or numeric precision are removed.

Indexing uses disk-backed staging instead of loading the existing query vectors into memory. Updates are published atomically, so an interrupted write does not replace the last committed index with a partial file. If Obsidian is force-quit mid-run, the committed index stays intact and the next indexing run discards the interrupted run's staging, re-embedding only new or changed files. Query vectors are loaded on demand after indexing, rather than eagerly at startup.

File changes use a trailing-edge debounce: each change resets the quiet window, and changed paths are coalesced. Active chat and the three-minute window after chat activity prevent reindexing from taking the database offline. Manual indexing requests wait when chat has priority. Changes arriving during indexing are queued for a subsequent refresh.

---

## Commands

Open the command palette (`Cmd/Ctrl+P`) and search for **RAG**:

| Command | Description |
|---|---|
| **RAG: Ask a question** | Open the chat panel and query your vault. |
| **RAG: Index all files** | Build or refresh the full index. Run this after first install or after changing the embedding model. |
| **RAG: Index current file** | Re-index only the active file. |
| **RAG: Cancel indexing** | Abort an in-progress index run. |

---

## License

MIT
