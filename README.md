# Obsidian RAG

Local retrieval-augmented generation (RAG) for [Obsidian](https://obsidian.md). Ask questions about your vault — PDFs and Markdown notes — using a fully local LLM and embedding model. No data leaves your machine.

Supports [Ollama](https://ollama.com) and [LM Studio](https://lmstudio.ai) as providers.

---

## Features

- Semantic search over PDFs and Markdown notes
- Section-aware chunking that preserves heading context
- Streaming answers with inline citations
- Works entirely offline — no API keys, no cloud

---

## Installation

This plugin is not yet in the Obsidian community plugin directory. Install it manually:

### Option A — Pre-built (no Node.js required)

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest).
2. In your vault, create the folder `.obsidian/plugins/obsidian-rag/`.
3. Copy the three files into that folder.
4. Open Obsidian → **Settings → Community plugins** → turn off Safe Mode if prompted → enable **Obsidian RAG**.

### Option B — Build from source

```bash
git clone https://github.com/badvision/obsidian-rag.git
cd obsidian-rag
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/obsidian-rag/` folder and enable the plugin as above.

---

## Prerequisites

You need a running local LLM provider with **both** a chat model and an embedding model loaded.

### Ollama (recommended)

Install from [ollama.com](https://ollama.com), then pull the models you want:

```bash
# Chat model — generates the answers
ollama pull llama3.2

# Embedding model — powers the semantic index
ollama pull nomic-embed-text
```

Ollama runs on `http://localhost:11434` by default.

### LM Studio / MLX

Install from [lmstudio.ai](https://lmstudio.ai). Download a chat model and an embedding model from the model library, then start the **Local Server** (default: `http://localhost:1234`). Make sure both models are loaded before indexing or querying.

---

## Configuration

Open **Settings → Obsidian RAG** after enabling the plugin.

### Provider

| Setting | Description |
|---|---|
| **Provider** | Choose *Ollama* or *LM Studio / MLX*. Switching resets the Base URL automatically. |
| **Base URL** | The HTTP endpoint of your provider. Change this only if you moved the server to a different port or host. |

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

Use the **Test Connection** button to verify both models are reachable and to confirm the embedding dimension before indexing.

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
| **Auto-index on Startup** | Re-index any changed files when Obsidian loads. Keeps the index fresh automatically at the cost of a short startup delay. |

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
