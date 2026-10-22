"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => RagPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian6 = require("obsidian");
var import_path3 = require("path");

// src/settings.ts
var import_obsidian3 = require("obsidian");
var import_path2 = require("path");

// src/providers/ollama.ts
var import_obsidian = require("obsidian");

// src/providers/types.ts
var ProviderError = class extends Error {
  constructor(message, code, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "ProviderError";
  }
};

// src/providers/nodeHttp.ts
var http = require("http");
var https = require("https");
function nodeStreamPost(opts) {
  return new Promise((resolve, reject) => {
    const { url, body, signal, onLine } = opts;
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          let errBody = "";
          res.on("data", (chunk) => {
            errBody += chunk.toString("utf8");
          });
          res.on("end", () => {
            let detail = errBody.slice(0, 300);
            try {
              const parsed2 = JSON.parse(errBody);
              detail = parsed2?.error?.message ?? parsed2?.message ?? detail;
            } catch {
            }
            reject(new Error(`HTTP ${status}: ${detail}`));
          });
          return;
        }
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) onLine(line);
          }
        });
        res.on("end", () => {
          if (buffer.trim()) onLine(buffer);
          resolve();
        });
        res.on("error", reject);
      }
    );
    req.on("error", (err) => {
      if (signal.aborted) {
        reject(Object.assign(new Error("Stream aborted"), { name: "AbortError" }));
      } else {
        reject(err);
      }
    });
    signal.addEventListener("abort", () => req.destroy(), { once: true });
    req.write(body);
    req.end();
  });
}

// src/providers/ollama.ts
var OllamaEmbedder = class {
  constructor(baseUrl, embeddingModel) {
    this.baseUrl = baseUrl;
    this.embeddingModel = embeddingModel;
  }
  async embed(texts) {
    try {
      const response = await (0, import_obsidian.requestUrl)({
        url: `${this.baseUrl}/api/embed`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.embeddingModel, input: texts }),
        throw: false
      });
      if (response.status === 404) {
        return this.embedFallback(texts);
      }
      const data = response.json;
      const embeddings = data.embeddings;
      return { embeddings, dimension: embeddings[0].length };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        `Cannot connect to Ollama at ${this.baseUrl}`,
        "CONNECTION_REFUSED",
        err
      );
    }
  }
  async embedFallback(texts) {
    const embeddings = [];
    for (const text of texts) {
      try {
        const response = await (0, import_obsidian.requestUrl)({
          url: `${this.baseUrl}/api/embeddings`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.embeddingModel, prompt: text }),
          throw: false
        });
        if (response.status === 404) {
          throw new ProviderError(
            `Embedding model '${this.embeddingModel}' not found in Ollama`,
            "MODEL_NOT_FOUND"
          );
        }
        embeddings.push(response.json.embedding);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(
          `Cannot connect to Ollama at ${this.baseUrl}`,
          "CONNECTION_REFUSED",
          err
        );
      }
    }
    return { embeddings, dimension: embeddings[0].length };
  }
  async listModels() {
    try {
      const response = await (0, import_obsidian.requestUrl)({
        url: `${this.baseUrl}/api/tags`,
        method: "GET",
        throw: false
      });
      if (response.status < 200 || response.status >= 300) return [];
      const models = response.json.models ?? [];
      return models.map((m) => m.name).sort();
    } catch {
      return [];
    }
  }
  async ping() {
    const start = Date.now();
    try {
      const response = await (0, import_obsidian.requestUrl)({
        url: `${this.baseUrl}/api/version`,
        method: "GET",
        throw: false
      });
      const latencyMs = Date.now() - start;
      if (response.status >= 200 && response.status < 300) {
        return { reachable: true, latencyMs };
      }
      return { reachable: false, latencyMs, errorMessage: `HTTP ${response.status}` };
    } catch (err) {
      return { reachable: false, latencyMs: 0, errorMessage: err.message };
    }
  }
};
var OllamaChatProvider = class {
  constructor(baseUrl, chatModel) {
    this.baseUrl = baseUrl;
    this.chatModel = chatModel;
  }
  async chat(messages, signal, onToken) {
    const body = JSON.stringify({ model: this.chatModel, messages, stream: true });
    let accumulated = "";
    try {
      await nodeStreamPost({
        url: `${this.baseUrl}/api/chat`,
        body,
        signal,
        onLine: (line) => {
          try {
            const obj = JSON.parse(line);
            const content = obj.message?.content ?? "";
            if (content) {
              onToken?.(content);
              accumulated += content;
            }
          } catch {
          }
        }
      });
    } catch (err) {
      const error = err;
      if (error.name === "AbortError" || signal.aborted) {
        throw new ProviderError("Stream aborted", "STREAM_ABORTED", error);
      }
      throw new ProviderError(
        `Cannot connect to Ollama at ${this.baseUrl}`,
        "CONNECTION_REFUSED",
        error
      );
    }
    return accumulated;
  }
  async listModels() {
    try {
      const response = await (0, import_obsidian.requestUrl)({
        url: `${this.baseUrl}/api/tags`,
        method: "GET",
        throw: false
      });
      if (response.status < 200 || response.status >= 300) return [];
      const models = response.json.models ?? [];
      return models.map((m) => m.name).sort();
    } catch {
      return [];
    }
  }
  async ping() {
    const start = Date.now();
    try {
      const response = await (0, import_obsidian.requestUrl)({
        url: `${this.baseUrl}/api/version`,
        method: "GET",
        throw: false
      });
      const latencyMs = Date.now() - start;
      if (response.status >= 200 && response.status < 300) {
        return { reachable: true, latencyMs };
      }
      return { reachable: false, latencyMs, errorMessage: `HTTP ${response.status}` };
    } catch (err) {
      return { reachable: false, latencyMs: 0, errorMessage: err.message };
    }
  }
};

// src/providers/lmstudio.ts
var import_obsidian2 = require("obsidian");
var LMStudioEmbedder = class {
  constructor(baseUrl, embeddingModel) {
    this.baseUrl = baseUrl;
    this.embeddingModel = embeddingModel;
  }
  async embed(texts) {
    try {
      const response = await (0, import_obsidian2.requestUrl)({
        url: `${this.baseUrl}/v1/embeddings`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.embeddingModel, input: texts }),
        throw: false
      });
      if (response.status < 200 || response.status >= 300) {
        throw new ProviderError(
          `LM Studio embeddings failed: ${response.status}`,
          "UNEXPECTED_RESPONSE"
        );
      }
      const data = response.json;
      const embeddings = data.data.map(
        (item) => item.embedding
      );
      return { embeddings, dimension: embeddings[0].length };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        `Cannot connect to LM Studio at ${this.baseUrl}`,
        "CONNECTION_REFUSED",
        err
      );
    }
  }
  async listModels() {
    try {
      const response = await (0, import_obsidian2.requestUrl)({
        url: `${this.baseUrl}/v1/models`,
        method: "GET",
        throw: false
      });
      if (response.status < 200 || response.status >= 300) return [];
      const models = response.json.data ?? [];
      return models.map((m) => m.id).sort();
    } catch {
      return [];
    }
  }
  async ping() {
    const start = Date.now();
    try {
      const response = await (0, import_obsidian2.requestUrl)({
        url: `${this.baseUrl}/v1/models`,
        method: "GET",
        throw: false
      });
      const latencyMs = Date.now() - start;
      if (response.status >= 200 && response.status < 300) {
        return { reachable: true, latencyMs };
      }
      return { reachable: false, latencyMs, errorMessage: `HTTP ${response.status}` };
    } catch (err) {
      return { reachable: false, latencyMs: 0, errorMessage: err.message };
    }
  }
};
var LMStudioChatProvider = class {
  constructor(baseUrl, chatModel) {
    this.baseUrl = baseUrl;
    this.chatModel = chatModel;
  }
  async chat(messages, signal, onToken) {
    const body = JSON.stringify({ model: this.chatModel, messages, stream: true });
    let accumulated = "";
    let done = false;
    try {
      await nodeStreamPost({
        url: `${this.baseUrl}/v1/chat/completions`,
        body,
        signal,
        onLine: (line) => {
          if (done) return;
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) return;
          const payload = trimmed.slice("data: ".length);
          if (payload === "[DONE]") {
            done = true;
            return;
          }
          try {
            const obj = JSON.parse(payload);
            const content = obj.choices?.[0]?.delta?.content ?? "";
            if (content) {
              onToken?.(content);
              accumulated += content;
            }
          } catch {
          }
        }
      });
    } catch (err) {
      const error = err;
      if (error.name === "AbortError" || signal.aborted) {
        throw new ProviderError("Stream aborted", "STREAM_ABORTED", error);
      }
      throw new ProviderError(
        `Cannot connect to LM Studio at ${this.baseUrl}`,
        "CONNECTION_REFUSED",
        error
      );
    }
    return accumulated;
  }
  async listModels() {
    try {
      const response = await (0, import_obsidian2.requestUrl)({
        url: `${this.baseUrl}/v1/models`,
        method: "GET",
        throw: false
      });
      if (response.status < 200 || response.status >= 300) return [];
      const models = response.json.data ?? [];
      return models.map((m) => m.id).sort();
    } catch {
      return [];
    }
  }
  async ping() {
    const start = Date.now();
    try {
      const response = await (0, import_obsidian2.requestUrl)({
        url: `${this.baseUrl}/v1/models`,
        method: "GET",
        throw: false
      });
      const latencyMs = Date.now() - start;
      if (response.status >= 200 && response.status < 300) {
        return { reachable: true, latencyMs };
      }
      return { reachable: false, latencyMs, errorMessage: `HTTP ${response.status}` };
    } catch (err) {
      return { reachable: false, latencyMs: 0, errorMessage: err.message };
    }
  }
};

// src/providers/cli.ts
var cp = require("child_process");
var fs = require("fs");
var path = require("path");
var os = require("os");
var CLI_TOKENS = ["{prompt}", "{system}", "{question}", "{tmpdir}"];
var CLI_PRESETS = {
  opencode: "opencode run --format json --dir {tmpdir} {prompt}",
  omp: "omp -p --mode json --no-session {prompt}",
  custom: "{prompt}"
};
var CLI_TEMPLATE_PLACEHOLDER = "{prompt}";
var EXTRA_COMMAND_DIRS = [
  "~/.opencode/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "~/.local/bin",
  "~/.npm-global/bin"
];
function applyCliPreset(preset) {
  if (preset === "custom") return CLI_TEMPLATE_PLACEHOLDER;
  const template = CLI_PRESETS[preset];
  const name = template.trim().split(/\s+/)[0];
  const resolved = resolveCliCommand(name);
  return resolved ? template.replace(name, resolved) : template;
}
function tokenizeCliTemplate(template) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  if (inSingle || inDouble) {
    throw new ProviderError(
      "Unbalanced quotes in CLI command template",
      "UNEXPECTED_RESPONSE"
    );
  }
  return tokens;
}
function expandToken(token, values) {
  if (token === "{prompt}") return values.prompt;
  if (token === "{system}") return values.system;
  if (token === "{question}") return values.question;
  if (token === "{tmpdir}") return values.tmpdir;
  let out = token;
  for (const t of CLI_TOKENS) {
    out = out.split(t).join(t === "{prompt}" ? values.prompt : t === "{system}" ? values.system : t === "{question}" ? values.question : values.tmpdir);
  }
  return out;
}
function expandCliTemplate(template, values) {
  const trimmed = template.trim();
  if (!trimmed) {
    throw new ProviderError("CLI command template is empty", "UNEXPECTED_RESPONSE");
  }
  if (!trimmed.includes("{prompt}") && !trimmed.includes("{system}") && !trimmed.includes("{question}")) {
    throw new ProviderError(
      "CLI command template must contain {prompt} (or {system} / {question})",
      "UNEXPECTED_RESPONSE"
    );
  }
  const tokens = tokenizeCliTemplate(trimmed);
  if (tokens.length === 0) {
    throw new ProviderError("CLI command template is empty", "UNEXPECTED_RESPONSE");
  }
  return tokens.map((t) => expandToken(t, values));
}
function resolveCliCommand(name) {
  if (!name) return null;
  if (name.includes("/")) {
    return fs.existsSync(name) ? name : null;
  }
  const home = os.homedir();
  const dirs = [];
  const envPath = process.env.PATH ?? "";
  for (const dir of envPath.split(":")) {
    if (dir) dirs.push(dir);
  }
  for (const dir of EXTRA_COMMAND_DIRS) {
    dirs.push(dir.startsWith("~/") ? path.join(home, dir.slice(2)) : dir);
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
function findTextField(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const found = findTextField(value[i]);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const obj = value;
    for (const field of ["text", "content", "answer", "output"]) {
      const candidate = obj[field];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    for (const field of ["content", "message", "messages", "delta", "data", "result", "response"]) {
      const nested = obj[field];
      if (nested && typeof nested === "object") {
        const found = findTextField(nested);
        if (found !== null) return found;
      }
    }
  }
  return null;
}
function isAssistantEvent(value) {
  if (value == null || typeof value !== "object") return false;
  const obj = value;
  const message = obj["message"];
  if (message && typeof message === "object") {
    const role = message["role"];
    return role === "assistant";
  }
  const messages = obj["messages"];
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1];
    return last !== null && typeof last === "object" && last["role"] === "assistant";
  }
  return obj["role"] === "assistant";
}
function extractCliAnswer(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const found = findTextField(JSON.parse(trimmed));
      if (found !== null) return found;
    } catch {
    }
  }
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isAssistantEvent(parsed)) continue;
    const found = findTextField(parsed);
    if (found !== null) return found;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      const found = findTextField(JSON.parse(line));
      if (found !== null) return found;
    } catch {
    }
  }
  return trimmed;
}
var CLI_PROBE_PROMPT = "Reply with exactly one word: PONG";
var _CliChatProvider = class _CliChatProvider {
  constructor(template, timeoutMs = _CliChatProvider.DEFAULT_TIMEOUT_MS) {
    this.template = template;
    this.timeoutMs = timeoutMs;
  }
  async run(values, signal, timeoutMs) {
    if (signal.aborted) {
      throw new ProviderError("Stream aborted", "STREAM_ABORTED");
    }
    const argv = expandCliTemplate(this.template, values);
    const resolved = resolveCliCommand(argv[0]);
    if (!resolved) {
      throw new ProviderError(
        `Command '${argv[0]}' not found. Enter the full path in the command template (e.g. /opt/homebrew/bin/omp).`,
        "CONNECTION_REFUSED"
      );
    }
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-rag-"));
    try {
      return await new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let child;
        try {
          child = cp.spawn(resolved, argv.slice(1), {
            cwd: tmpdir,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"]
          });
          if (!child.stdout || !child.stderr) {
            child.kill("SIGTERM");
            reject(new ProviderError(
              `Could not capture output from '${resolved}'`,
              "CONNECTION_REFUSED"
            ));
            return;
          }
          child.stdout.on("data", (d) => {
            stdout += d.toString("utf8");
          });
          child.stderr.on("data", (d) => {
            stderr += d.toString("utf8");
          });
        } catch (err) {
          reject(new ProviderError(
            `Failed to launch '${resolved}': ${err.message}`,
            "CONNECTION_REFUSED",
            err
          ));
          return;
        }
        const timer = setTimeout(() => {
          if (!settled) {
            timedOut = true;
            child.kill("SIGTERM");
          }
        }, timeoutMs);
        const onAbort = () => child.kill("SIGTERM");
        signal.addEventListener("abort", onAbort, { once: true });
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        };
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (signal.aborted) {
            reject(new ProviderError("Stream aborted", "STREAM_ABORTED", err));
          } else {
            reject(new ProviderError(
              `Failed to launch '${resolved}': ${err.message}`,
              "CONNECTION_REFUSED",
              err
            ));
          }
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            stdout,
            stderr,
            code: code ?? -1,
            aborted: signal.aborted,
            timedOut
          });
        });
      });
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  }
  async chat(messages, signal, onToken) {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const question = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const prompt = messages.map((m) => m.content).join("\n\n");
    const result = await this.run({ prompt, system, question, tmpdir: "" }, signal, this.timeoutMs);
    if (result.aborted) {
      throw new ProviderError("Stream aborted", "STREAM_ABORTED");
    }
    if (result.timedOut) {
      throw new ProviderError(
        `CLI command timed out after ${Math.round(this.timeoutMs / 1e3)}s`,
        "REQUEST_TIMEOUT"
      );
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(0, 300);
      throw new ProviderError(
        `CLI exited with code ${result.code}${detail ? `: ${detail}` : ""}`,
        "UNEXPECTED_RESPONSE"
      );
    }
    const answer = extractCliAnswer(result.stdout);
    if (!answer) {
      throw new ProviderError("CLI returned an empty response", "UNEXPECTED_RESPONSE");
    }
    onToken?.(answer);
    return answer;
  }
  /**
   * Round-trip probe: runs a minimal prompt through the real command and
   * reports the extracted answer in sampleResponse so the user can verify
   * the template's output is parseable.
   */
  async ping() {
    const start = Date.now();
    try {
      const answer = await this.chat(
        [{ role: "user", content: CLI_PROBE_PROMPT }],
        new AbortController().signal,
        void 0
      );
      return { reachable: true, latencyMs: Date.now() - start, sampleResponse: answer };
    } catch (err) {
      return { reachable: false, latencyMs: 0, errorMessage: err.message };
    }
  }
  async listModels() {
    return [];
  }
};
_CliChatProvider.DEFAULT_TIMEOUT_MS = 18e4;
_CliChatProvider.PROBE_TIMEOUT_MS = 6e4;
var CliChatProvider = _CliChatProvider;

// src/providers/onnx.ts
var import_path = require("path");
var import_module = require("module");
var ONNX_MODELS = {
  "Xenova/all-MiniLM-L6-v2": { label: "all-MiniLM-L6-v2 (384d, fast, English)", dimension: 384 },
  "Xenova/all-mpnet-base-v2": { label: "all-mpnet-base-v2 (768d, strong, English)", dimension: 768 },
  "Xenova/bge-small-en-v1.5": { label: "bge-small-en-v1.5 (384d, strong, English)", dimension: 384 },
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": { label: "paraphrase-multilingual-MiniLM-L12-v2 (384d, multilingual)", dimension: 384 },
  "keisuke-miyako/nomic-embed-text-v1.5-onnx-int8": {
    label: "nomic-embed-text-v1.5 int8 (768d \u2014 same family as LM Studio nomic)",
    dimension: 768,
    load: { subfolder: "", model_file_name: "model_quantized", dtype: "fp32" }
  }
};
var DEFAULT_ONNX_MODEL = "Xenova/all-MiniLM-L6-v2";
var OnnxEmbedder = class {
  constructor(options) {
    this.options = options;
    this.pipePromise = null;
  }
  defaultLoader() {
    return async () => {
      const requireFromPlugin = (0, import_module.createRequire)((0, import_path.join)(this.options.pluginDir, "main.js"));
      const tf = requireFromPlugin("@huggingface/transformers");
      tf.env.cacheDir = (0, import_path.join)(this.options.pluginDir, "models");
      return tf;
    };
  }
  loadPipeline() {
    if (!this.pipePromise) {
      this.pipePromise = this.load().then((pipe) => {
        this.options.onProgress?.(`Embedding model ready (${this.options.model})`);
        return pipe;
      }).catch((err) => {
        this.pipePromise = null;
        throw err;
      });
    }
    return this.pipePromise;
  }
  async load() {
    let tf;
    try {
      tf = await (this.options.loader ?? this.defaultLoader())();
    } catch (err) {
      throw this.wrapLoadError(err);
    }
    const load = ONNX_MODELS[this.options.model]?.load;
    const dtypes = load?.dtype ? [load.dtype] : ["q8", "fp32"];
    const preferred = this.options.device ?? "cpu";
    const devices = preferred === "coreml" ? ["coreml", "cpu"] : ["cpu"];
    let lastErr = null;
    for (const device of devices) {
      for (const dtype of dtypes) {
        try {
          return await this.createPipeline(tf, { device, dtype, ...this.fileOptions() });
        } catch (err) {
          lastErr = err;
          this.options.onProgress?.(
            `ONNX load failed (${device}/${dtype}), trying next variant: ${err.message}`
          );
        }
      }
    }
    throw this.wrapLoadError(lastErr);
  }
  /** File-layout overrides for repos with a non-standard ONNX layout. */
  fileOptions() {
    const load = ONNX_MODELS[this.options.model]?.load;
    return load?.subfolder !== void 0 || load?.model_file_name !== void 0 ? { subfolder: load?.subfolder, model_file_name: load?.model_file_name } : {};
  }
  async createPipeline(tf, opts) {
    const progress = this.options.onProgress;
    return await tf.pipeline("feature-extraction", this.options.model, {
      ...opts,
      progress_callback: (p) => {
        const file = typeof p.file === "string" ? p.file : "";
        if (p.status === "progress" && file) {
          const pct = typeof p.progress === "number" ? Math.round(p.progress) : 0;
          progress?.(`Downloading ${file} for ${this.options.model}: ${pct}%`);
        }
      }
    });
  }
  /** Maps raw load/loader failures to actionable ProviderErrors. */
  wrapLoadError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return new ProviderError(
      `Failed to load embedding model '${this.options.model}': ${message}`,
      "MODEL_NOT_FOUND",
      err
    );
  }
  async embed(texts) {
    const pipe = await this.loadPipeline();
    const embeddings = [];
    for (const text of texts) {
      let out;
      try {
        out = await pipe(text, { pooling: "mean", normalize: true });
      } catch (err) {
        throw new ProviderError(
          `ONNX inference failed: ${err.message ?? String(err)}`,
          "UNEXPECTED_RESPONSE",
          err
        );
      }
      embeddings.push(Array.from(out.data));
    }
    return { embeddings, dimension: embeddings[0].length };
  }
  /**
   * Full round-trip: loads (and on first run downloads) the model, then embeds
   * a sample. Doubles as the "Test Connection" probe for this provider.
   */
  async ping() {
    const start = Date.now();
    try {
      const result = await this.embed(["round-trip probe"]);
      return {
        reachable: true,
        latencyMs: Date.now() - start,
        sampleResponse: `${result.dimension}-dim vector`
      };
    } catch (err) {
      return {
        reachable: false,
        latencyMs: Date.now() - start,
        errorMessage: err instanceof ProviderError ? err.message : err.message
      };
    }
  }
  async listModels() {
    return Object.keys(ONNX_MODELS);
  }
};

// src/providers/factory.ts
function createEmbedder(settings, pluginDir, onProgress) {
  if (settings.embeddingProvider === "lmstudio") {
    return new LMStudioEmbedder(settings.embeddingBaseUrl, settings.embeddingModel);
  }
  if (settings.embeddingProvider === "onnx") {
    return new OnnxEmbedder({
      model: settings.embeddingModel,
      pluginDir: pluginDir ?? "",
      onProgress,
      device: settings.onnxDevice
    });
  }
  return new OllamaEmbedder(settings.embeddingBaseUrl, settings.embeddingModel);
}
function createChatProvider(settings) {
  if (settings.chatProvider === "lmstudio") {
    return new LMStudioChatProvider(settings.chatBaseUrl, settings.chatModel);
  }
  if (settings.chatProvider === "cli") {
    return new CliChatProvider(settings.cliTemplate);
  }
  return new OllamaChatProvider(settings.chatBaseUrl, settings.chatModel);
}

// src/settings.ts
var DEFAULT_SETTINGS = {
  embeddingProvider: "ollama",
  embeddingBaseUrl: "http://localhost:11434",
  embeddingModel: "nomic-embed-text",
  onnxDevice: "cpu",
  chatProvider: "ollama",
  chatBaseUrl: "http://localhost:11434",
  chatModel: "llama3.2",
  cliPreset: "opencode",
  cliTemplate: CLI_PRESETS.opencode,
  topK: 20,
  chunkSize: 500,
  chunkOverlap: 50,
  indexScope: "pdfs-and-notes",
  streamingEnabled: true,
  autoIndexOnStartup: false,
  indexVersion: 1,
  embeddingDimension: 0
};
function migrateLegacySettings(raw) {
  if (!raw) return {};
  const result = { ...raw };
  if (raw.provider !== void 0 && raw.embeddingProvider === void 0 && raw.chatProvider === void 0) {
    result.embeddingProvider = raw.provider;
    result.chatProvider = raw.provider;
    if (raw.baseUrl !== void 0) {
      if (result.embeddingBaseUrl === void 0) result.embeddingBaseUrl = raw.baseUrl;
      if (result.chatBaseUrl === void 0) result.chatBaseUrl = raw.baseUrl;
    }
    delete result.provider;
    delete result.baseUrl;
  }
  return result;
}
var EMBEDDER_DEFAULT_URL = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
  onnx: ""
};
var CHATTER_DEFAULT_URL = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234"
};
var RagSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  addModelDropdown(containerEl, name, desc, provider, getValue, setValue) {
    const setting = new import_obsidian3.Setting(containerEl).setName(name).setDesc(desc);
    const select = setting.controlEl.createEl("select", { cls: "dropdown" });
    const loadingOpt = select.createEl("option", { text: "Loading models\u2026", value: "" });
    loadingOpt.disabled = true;
    const currentOpt = select.createEl("option", { text: getValue(), value: getValue() });
    currentOpt.selected = true;
    select.addEventListener("change", async () => {
      if (select.value) await setValue(select.value);
    });
    provider.listModels().then((models) => {
      select.empty();
      if (models.length === 0) {
        select.createEl("option", { text: "(provider unreachable \u2014 type manually)", value: getValue() }).selected = true;
        select.disabled = true;
        const input = setting.controlEl.createEl("input", { type: "text", cls: "rag-model-text-input" });
        input.value = getValue();
        input.addEventListener("change", async () => {
          await setValue(input.value.trim());
        });
        select.style.display = "none";
        return;
      }
      const allModels = models.includes(getValue()) ? models : [getValue(), ...models];
      allModels.forEach((m) => {
        const opt = select.createEl("option", { text: m, value: m });
        if (m === getValue()) opt.selected = true;
      });
    }).catch(() => {
      select.empty();
      select.createEl("option", { text: getValue(), value: getValue() }).selected = true;
    });
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "RAG Plugin Settings" });
    containerEl.createEl("h3", { text: "Embeddings" });
    new import_obsidian3.Setting(containerEl).setName("Embedding Provider").setDesc("Provider used to build the semantic index").addDropdown(
      (dd) => dd.addOption("ollama", "Ollama").addOption("lmstudio", "LM Studio / MLX").addOption("onnx", "Self-hosted ONNX (in-process, no server)").setValue(this.plugin.settings.embeddingProvider).onChange(async (value) => {
        this.plugin.settings.embeddingProvider = value;
        this.plugin.settings.embeddingBaseUrl = EMBEDDER_DEFAULT_URL[value];
        if (value === "onnx" && !ONNX_MODELS[this.plugin.settings.embeddingModel]) {
          this.plugin.settings.embeddingModel = DEFAULT_ONNX_MODEL;
        }
        await this.plugin.saveSettings();
        this.display();
      })
    );
    if (this.plugin.settings.embeddingProvider !== "onnx") {
      new import_obsidian3.Setting(containerEl).setName("Embedding Base URL").setDesc("Embedding provider endpoint URL").addText(
        (text) => text.setValue(this.plugin.settings.embeddingBaseUrl).onChange(async (value) => {
          this.plugin.settings.embeddingBaseUrl = value;
          await this.plugin.saveSettings();
        })
      );
    }
    this.addModelDropdown(
      containerEl,
      "Embedding Model",
      "Model for embeddings \u2014 changing this requires a full re-index",
      createEmbedder(this.plugin.settings, (0, import_path2.join)(
        this.app.vault.adapter.getBasePath(),
        this.plugin.manifest?.dir ?? ""
      )),
      () => this.plugin.settings.embeddingModel,
      async (v) => {
        this.plugin.settings.embeddingModel = v;
        await this.plugin.saveSettings();
      }
    );
    if (this.plugin.settings.embeddingProvider === "onnx") {
      new import_obsidian3.Setting(containerEl).setName("ONNX Model Info").setDesc(
        `Model downloads on first use (~20-130 MB) and is cached at ${this.plugin.manifest?.dir ?? ".obsidian/plugins/obsidian-rag"}/models/. No server or network needed afterwards. Runs inside Obsidian \u2014 first use of a model takes a few seconds.`
      );
      new import_obsidian3.Setting(containerEl).setName("ONNX Device").setDesc(
        "Where inference runs. CoreML uses Apple Silicon (GPU/ANE) and is much faster; if a model is unsupported there it automatically falls back to CPU."
      ).addDropdown(
        (dd) => dd.addOption("cpu", "CPU (safe, portable)").addOption("coreml", "CoreML \u2014 Apple GPU/ANE (faster)").setValue(this.plugin.settings.onnxDevice).onChange(async (value) => {
          this.plugin.settings.onnxDevice = value;
          await this.plugin.saveSettings();
        })
      );
    }
    containerEl.createEl("h3", { text: "Chat" });
    new import_obsidian3.Setting(containerEl).setName("Chat Provider").setDesc("Provider used to generate answers").addDropdown(
      (dd) => dd.addOption("ollama", "Ollama").addOption("lmstudio", "LM Studio / MLX").addOption("cli", "CLI (OpenCode / OMP / custom)").setValue(this.plugin.settings.chatProvider).onChange(async (value) => {
        const provider = value;
        this.plugin.settings.chatProvider = provider;
        if (provider !== "cli") {
          this.plugin.settings.chatBaseUrl = CHATTER_DEFAULT_URL[provider];
        } else if (this.plugin.settings.cliTemplate === CLI_PRESETS[this.plugin.settings.cliPreset]) {
          this.plugin.settings.cliTemplate = applyCliPreset(this.plugin.settings.cliPreset);
        }
        await this.plugin.saveSettings();
        this.display();
      })
    );
    if (this.plugin.settings.chatProvider !== "cli") {
      new import_obsidian3.Setting(containerEl).setName("Chat Base URL").setDesc("Chat provider endpoint URL").addText(
        (text) => text.setValue(this.plugin.settings.chatBaseUrl).onChange(async (value) => {
          this.plugin.settings.chatBaseUrl = value;
          await this.plugin.saveSettings();
        })
      );
      this.addModelDropdown(
        containerEl,
        "Chat Model",
        "Model for answer generation",
        createChatProvider(this.plugin.settings),
        () => this.plugin.settings.chatModel,
        async (v) => {
          this.plugin.settings.chatModel = v;
          await this.plugin.saveSettings();
        }
      );
      new import_obsidian3.Setting(containerEl).setName("Enable Streaming").setDesc("Stream answer tokens as they are generated").addToggle(
        (toggle) => toggle.setValue(this.plugin.settings.streamingEnabled).onChange(async (value) => {
          this.plugin.settings.streamingEnabled = value;
          await this.plugin.saveSettings();
        })
      );
    } else {
      new import_obsidian3.Setting(containerEl).setName("CLI Preset").setDesc(
        "Starting point for the command line. OpenCode/OMP use their one-shot modes; Custom starts as a bare {prompt}."
      ).addDropdown(
        (dd) => dd.addOption("opencode", "OpenCode").addOption("omp", "OMP").addOption("custom", "Custom").setValue(this.plugin.settings.cliPreset).onChange(async (value) => {
          this.plugin.settings.cliPreset = value;
          this.plugin.settings.cliTemplate = applyCliPreset(value);
          await this.plugin.saveSettings();
          this.display();
        })
      );
      const cliSetting = new import_obsidian3.Setting(containerEl).setName("CLI Command").setDesc(
        `Full command line. Tokens: ${CLI_TOKENS.join(", ")}. {prompt} = the whole RAG conversation, {system} = system prompt, {question} = the current question, {tmpdir} = a throwaway working directory. Add your own flags (model, agent, \u2026) freely. Saves when you leave the field.`
      );
      cliSetting.settingEl.addClass("rag-cli-row");
      const cliInput = cliSetting.controlEl.createEl("textarea", {
        cls: "text-input rag-cli-template",
        attr: { spellcheck: "false", rows: "4" }
      });
      cliInput.value = this.plugin.settings.cliTemplate;
      cliInput.addEventListener("change", async () => {
        this.plugin.settings.cliTemplate = cliInput.value;
        await this.plugin.saveSettings();
      });
    }
    new import_obsidian3.Setting(containerEl).setName("Test Connection").setDesc("Verify both providers: embedding round-trip, and a real chat round-trip for CLI").addButton(
      (btn) => btn.setButtonText("Test").onClick(async () => {
        btn.setButtonText("Testing...");
        btn.disabled = true;
        try {
          const embedder = createEmbedder(
            this.plugin.settings,
            (0, import_path2.join)(this.app.vault.adapter.getBasePath(), this.plugin.manifest?.dir ?? ""),
            (message) => new import_obsidian3.Notice(message, 3e3)
          );
          const embedPing = await embedder.ping();
          if (!embedPing.reachable) {
            new import_obsidian3.Notice(
              `\u274C Embeddings: provider not reachable: ${embedPing.errorMessage ?? "connection failed"}`,
              1e4
            );
          } else {
            const embedResult = await embedder.embed(["test"]);
            new import_obsidian3.Notice(
              `\u2713 Embeddings: ${this.plugin.settings.embeddingModel} returns ${embedResult.dimension}-dim vectors (${embedPing.latencyMs}ms)`,
              1e4
            );
          }
          const chat = createChatProvider(this.plugin.settings);
          const chatPing = await chat.ping();
          if (!chatPing.reachable) {
            new import_obsidian3.Notice(
              `\u274C Chat: not reachable: ${chatPing.errorMessage ?? "connection failed"}`,
              1e4
            );
          } else if (chatPing.sampleResponse !== void 0) {
            const sample = chatPing.sampleResponse.length > 120 ? chatPing.sampleResponse.slice(0, 117) + "\u2026" : chatPing.sampleResponse;
            new import_obsidian3.Notice(
              `\u2713 Chat: round-trip OK in ${chatPing.latencyMs}ms \u2014 parsed reply: ${sample}`,
              1e4
            );
          } else {
            new import_obsidian3.Notice(`\u2713 Chat: provider reachable (${chatPing.latencyMs}ms)`, 1e4);
          }
        } catch (err) {
          new import_obsidian3.Notice(`\u274C ${err.message}`, 1e4);
        } finally {
          btn.setButtonText("Test");
          btn.disabled = false;
        }
      })
    );
    containerEl.createEl("h3", { text: "Retrieval" });
    new import_obsidian3.Setting(containerEl).setName("Top K Results").setDesc("Number of document chunks to retrieve per query (1-50). Use 20+ when searching a large vault with many notes.").addText(
      (text) => text.setValue(String(this.plugin.settings.topK)).onChange(async (value) => {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n > 0 && n <= 50) {
          this.plugin.settings.topK = n;
          await this.plugin.saveSettings();
        }
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Chunk Size").setDesc("Approximate token size per chunk (100-2000)").addText(
      (text) => text.setValue(String(this.plugin.settings.chunkSize)).onChange(async (value) => {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n >= 100 && n <= 2e3) {
          this.plugin.settings.chunkSize = n;
          await this.plugin.saveSettings();
        }
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Index Scope").setDesc("Which files to include when indexing").addDropdown(
      (dd) => dd.addOption("pdfs-and-notes", "PDFs and Markdown notes").addOption("pdfs-only", "PDFs only").setValue(this.plugin.settings.indexScope).onChange(async (value) => {
        this.plugin.settings.indexScope = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian3.Setting(containerEl).setName("Auto-index on Startup").setDesc("Automatically re-index changed files when Obsidian starts").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoIndexOnStartup).onChange(async (value) => {
        this.plugin.settings.autoIndexOnStartup = value;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "Index Management" });
    new import_obsidian3.Setting(containerEl).setName("Index Location").setDesc(`Stored at: ${this.plugin.manifest?.dir ?? ".obsidian/plugins/obsidian-rag"}/index/index.json`);
    new import_obsidian3.Setting(containerEl).setName("Clear Index").setDesc("Clear indexed data, or re-index files using the current embedding settings. Unchanged files are skipped.").addButton(
      (btn) => btn.setButtonText("Clear").onClick(async () => {
        if (confirm("Clear the entire document index? This cannot be undone.")) {
          await this.plugin.vectorStore?.clear(this.plugin.settings.embeddingModel);
          new import_obsidian3.Notice('Index cleared. Run "RAG: Index all files" to re-index.');
        }
      })
    ).addButton(
      (btn) => btn.setButtonText("Re-index").onClick(async () => {
        btn.disabled = true;
        try {
          await this.plugin.indexAll();
        } finally {
          btn.disabled = false;
        }
      })
    );
  }
};

// src/store/VectorStore.ts
var CURRENT_SCHEMA_VERSION = 2;
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
var VectorStore = class {
  constructor(pluginDir, app) {
    this.pluginDir = pluginDir;
    this.app = app;
    this.loaded = false;
    this.schemaUpgraded = false;
    this.indexPath = pluginDir + "/index/index.json";
    this.data = this.emptyIndex("");
  }
  emptyIndex(embeddingModel) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      embeddingModel,
      embeddingDimension: 0,
      createdAt: now,
      updatedAt: now,
      files: {},
      chunks: []
    };
  }
  async ensureLoaded(embeddingModel) {
    if (this.loaded) return;
    const exists = await this.app.vault.adapter.exists(this.indexPath);
    if (!exists) {
      this.data = this.emptyIndex(embeddingModel);
      this.loaded = true;
      return;
    }
    const raw = await this.app.vault.adapter.read(this.indexPath);
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      this.schemaUpgraded = true;
      this.data = this.emptyIndex(embeddingModel);
      this.loaded = true;
      return;
    }
    if (parsed.embeddingModel === "") {
      parsed.embeddingModel = embeddingModel;
    } else if (parsed.embeddingModel !== embeddingModel) {
      throw new ProviderError(
        `Embedding model changed from '${parsed.embeddingModel}' to '${embeddingModel}'. Re-index required.`,
        "DIMENSION_MISMATCH"
      );
    }
    this.data = parsed;
    this.loaded = true;
  }
  async save() {
    this.data.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.app.vault.adapter.mkdir(this.pluginDir + "/index");
    await this.app.vault.adapter.write(this.indexPath, JSON.stringify(this.data, null, 2));
  }
  upsertFile(vaultPath, mtime, chunks) {
    this.data.chunks = this.data.chunks.filter((c) => c.vaultPath !== vaultPath);
    this.data.chunks.push(...chunks);
    if (this.data.embeddingDimension === 0 && chunks.length > 0 && chunks[0].embedding.length > 0) {
      this.data.embeddingDimension = chunks[0].embedding.length;
    }
    const entry = {
      vaultPath,
      mtime,
      chunkIds: chunks.map((c) => c.id)
    };
    this.data.files[vaultPath] = entry;
  }
  removeFile(vaultPath) {
    this.data.chunks = this.data.chunks.filter((c) => c.vaultPath !== vaultPath);
    delete this.data.files[vaultPath];
  }
  getFileMtime(vaultPath) {
    return this.data.files[vaultPath]?.mtime ?? null;
  }
  query(queryEmbedding, topK) {
    if (this.data.chunks.length === 0) return [];
    const scored = this.data.chunks.map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding)
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
  async clear(embeddingModel) {
    this.data = this.emptyIndex(embeddingModel);
    await this.save();
  }
  async exists() {
    return this.app.vault.adapter.exists(this.indexPath);
  }
  getStats() {
    return {
      fileCount: Object.keys(this.data.files).length,
      chunkCount: this.data.chunks.length,
      embeddingModel: this.data.embeddingModel,
      updatedAt: this.data.updatedAt
    };
  }
};

// src/indexer/ChunkingService.ts
var ChunkingService = class {
  /**
   * Approximate token count using word count * 1.3 multiplier.
   */
  countTokensApprox(text) {
    return Math.floor(text.split(/\s+/).filter((t) => t.length > 0).length * 1.3);
  }
  /**
   * Sentence-aware sliding window chunker.
   * Splits text into chunks of approximately chunkSize tokens with chunkOverlap
   * tokens of overlap between consecutive chunks.
   */
  chunkText(text, chunkSize, chunkOverlap) {
    if (text.trim().length === 0) return [];
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
    const chunks = [];
    let currentChunk = "";
    for (const sentence of sentences) {
      const sentenceTokens = this.countTokensApprox(sentence);
      if (sentenceTokens > chunkSize) {
        if (currentChunk.trim().length > 0) {
          chunks.push(currentChunk.trim());
        }
        const wordChunks = this.splitLongSentence(sentence, chunkSize, chunkOverlap);
        for (const wc of wordChunks) {
          chunks.push(wc.trim());
        }
        currentChunk = this.buildOverlapPrefix(chunks[chunks.length - 1] ?? "", chunkOverlap);
        continue;
      }
      const candidate = currentChunk.length > 0 ? currentChunk + " " + sentence : sentence;
      if (this.countTokensApprox(candidate) > chunkSize && currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
        const overlapPrefix = this.buildOverlapPrefix(currentChunk, chunkOverlap);
        currentChunk = overlapPrefix.length > 0 ? overlapPrefix + " " + sentence : sentence;
      } else {
        currentChunk = candidate;
      }
    }
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }
    return chunks;
  }
  /**
   * Build an overlap prefix of approximately chunkOverlap tokens
   * from the tail of the previous chunk.
   */
  buildOverlapPrefix(prevChunk, chunkOverlap) {
    const words = prevChunk.trim().split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return "";
    const wordCount = Math.max(1, Math.ceil(chunkOverlap / 1.3));
    const overlapWords = words.slice(-wordCount);
    return overlapWords.join(" ");
  }
  /**
   * Split a single long sentence into word-level chunks with overlap.
   */
  splitLongSentence(sentence, chunkSize, chunkOverlap) {
    const words = sentence.split(/\s+/).filter((w) => w.length > 0);
    const chunks = [];
    let currentWords = [];
    for (const word of words) {
      const candidate = [...currentWords, word];
      if (this.countTokensApprox(candidate.join(" ")) > chunkSize && currentWords.length > 0) {
        chunks.push(currentWords.join(" "));
        const wordCount = Math.max(1, Math.ceil(chunkOverlap / 1.3));
        currentWords = currentWords.slice(-wordCount);
        currentWords.push(word);
      } else {
        currentWords.push(word);
      }
    }
    if (currentWords.length > 0) {
      chunks.push(currentWords.join(" "));
    }
    return chunks;
  }
};

// src/rag/EmbeddingService.ts
var EmbeddingService = class {
  constructor(provider) {
    this.provider = provider;
  }
  async embedBatch(texts, batchSize = 20) {
    if (texts.length === 0) return [];
    const allEmbeddings = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const result = await this.provider.embed(batch);
      allEmbeddings.push(...result.embeddings);
    }
    return allEmbeddings;
  }
  async embedQuery(text) {
    const result = await this.provider.embed([text]);
    return result.embeddings[0];
  }
};

// src/rag/CitationService.ts
var UNCERTAINTY_PHRASES = [
  "don't have",
  "insufficient",
  "not found",
  "not clear",
  "cannot find",
  "no information",
  "unable to find",
  "not available"
];
function basename(path2) {
  return path2.split("/").pop() ?? path2;
}
var CitationService = class {
  buildCitationSource(chunk, score) {
    if (chunk.sourceType === "pdf") {
      return {
        chunk,
        score,
        obsidianLink: `${chunk.vaultPath}#page=${chunk.page}`,
        displayLabel: `${basename(chunk.vaultPath)} p.${chunk.page}`
      };
    }
    const filename = basename(chunk.vaultPath);
    const displayLabel = filename.replace(/\.md$/i, "");
    return {
      chunk,
      score,
      obsidianLink: chunk.vaultPath,
      displayLabel
    };
  }
  formatContext(sources) {
    return sources.map((source, index) => {
      const i = index + 1;
      const filename = basename(source.chunk.vaultPath);
      if (source.chunk.sourceType === "pdf") {
        return `
[Source ${i}] FROM ${filename} - Page ${source.chunk.page} (cite as: [${i}])
${source.chunk.text}
`;
      }
      return `
[Source ${i}] FROM ${filename} (cite as: [${i}])
${source.chunk.text}
`;
    }).join("");
  }
  buildMessages(context, question) {
    return [
      {
        role: "system",
        content: `You are a precise research assistant. Answer questions based ONLY on the provided source documents.
Always cite your sources using [N] notation where N is the source number.
If information is not in the provided sources, say so clearly.
Be concise and accurate.`
      },
      {
        role: "user",
        content: `SOURCE DOCUMENTS:
${context}

QUESTION: ${question}

Answer based on the sources above, using [N] citation numbers.`
      }
    ];
  }
  validateCitations(answer, sources) {
    return answer.replace(/\[(\d+)\]/g, (match, numStr) => {
      const n = parseInt(numStr, 10);
      if (n < 1 || n > sources.length) return "";
      return match;
    });
  }
  assessConfidence(answer, sources) {
    const lower = answer.toLowerCase();
    if (UNCERTAINTY_PHRASES.some((p) => lower.includes(p))) {
      return "insufficient";
    }
    const citationCount = (answer.match(/\[\d+\]/g) || []).length;
    if (citationCount >= 3 && sources.length >= 3) {
      return "high";
    }
    if (citationCount >= 1) {
      return "medium";
    }
    return "low";
  }
};

// src/indexer/PDFIndexer.ts
var import_obsidian4 = require("obsidian");
var PDFIndexer = class {
  constructor(app, chunkingService, embeddingService, vectorStore) {
    this.app = app;
    this.chunkingService = chunkingService;
    this.embeddingService = embeddingService;
    this.vectorStore = vectorStore;
  }
  async indexFile(file, settings, onProgress, signal) {
    const storedMtime = this.vectorStore.getFileMtime(file.path);
    if (storedMtime === file.stat.mtime) {
      return { vaultPath: file.path, skipped: true, chunkCount: 0, pageCount: 0 };
    }
    const pdfjsLib = await (0, import_obsidian4.loadPdfJs)();
    const arrayBuffer = await this.app.vault.readBinary(file);
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;
    const pageTexts = [];
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (signal?.aborted) throw new Error("Indexing aborted");
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const text = textContent.items.map((item) => "str" in item ? item.str : "").join(" ").trim();
      pageTexts.push({ page: pageNum, text });
      onProgress?.(pageNum, totalPages);
    }
    const emptyPages = pageTexts.filter((p) => p.text.length < 10).length;
    const warningScannedPdf = emptyPages / totalPages > 0.3;
    const allChunks = [];
    for (const { page, text } of pageTexts) {
      if (!text) continue;
      const chunkTexts = this.chunkingService.chunkText(text, settings.chunkSize, settings.chunkOverlap);
      chunkTexts.forEach((chunkText, idx) => {
        allChunks.push({
          id: `${file.path}::p${page}::c${idx}`,
          text: chunkText,
          embedding: [],
          sourceType: "pdf",
          vaultPath: file.path,
          page,
          chunkIndex: idx
        });
      });
    }
    if (allChunks.length > 0) {
      const texts = allChunks.map((c) => c.text);
      const embeddings = await this.embeddingService.embedBatch(texts);
      allChunks.forEach((c, i) => {
        c.embedding = embeddings[i];
      });
    }
    this.vectorStore.upsertFile(file.path, file.stat.mtime, allChunks);
    return {
      vaultPath: file.path,
      skipped: false,
      chunkCount: allChunks.length,
      pageCount: totalPages,
      warningScannedPdf
    };
  }
};

// src/indexer/NoteIndexer.ts
function markdownToPlainText(markdown) {
  let text = markdown;
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/~~~[\s\S]*?~~~/g, "");
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1.");
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");
  text = text.replace(/^([\t ]*[-*+]\s+)\[[ xX]\]\s*/gm, "$1");
  text = text.replace(/^[\t ]*[-*+]\s+(.+)$/gm, "$1.");
  text = text.replace(/^[\t ]*\d+[.)]\s+(.+)$/gm, "$1.");
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1");
  text = text.replace(/_{1,3}([^_\n]+)_{1,3}/g, "$1");
  text = text.replace(/~~([^~\n]+)~~/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/^>\s*/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/([^\n])\n([^\n])/g, "$1 $2");
  return text.trim();
}
function splitByH2(text) {
  const parts = text.split(/^(?=##(?!#)\s)/m);
  return parts.map((part) => {
    const m = part.match(/^##(?!#)\s+(.+)\s*\n([\s\S]*)$/);
    if (m) return { title: m[1].trim(), content: m[2].trim() };
    const trimmed = part.trim();
    return trimmed ? { title: "", content: trimmed } : null;
  }).filter((s) => s !== null && (!!s.title || !!s.content));
}
function splitByH3(text) {
  const parts = text.split(/^(?=###(?!#)\s)/m);
  return parts.map((part) => {
    const m = part.match(/^###(?!#)\s+(.+)\s*\n([\s\S]*)$/);
    if (m) return { title: m[1].trim(), content: m[2].trim() };
    const trimmed = part.trim();
    return trimmed ? { title: "", content: trimmed } : null;
  }).filter((s) => s !== null && (!!s.title || !!s.content));
}
function chunkMarkdownBySections(text, chunkSize, chunkOverlap, chunkingService) {
  const h2Sections = splitByH2(text);
  if (h2Sections.length === 0 || h2Sections.length === 1 && !h2Sections[0].title) {
    const cleaned = markdownToPlainText(text);
    return chunkingService.chunkText(cleaned, chunkSize, chunkOverlap);
  }
  const result = [];
  const MIN_CONTENT_TOKENS = 10;
  for (const h2 of h2Sections) {
    const cleanedContent = markdownToPlainText(h2.content);
    if (chunkingService.countTokensApprox(cleanedContent) < MIN_CONTENT_TOKENS) continue;
    const sectionText = h2.title ? `${h2.title}. ${cleanedContent}` : cleanedContent;
    if (chunkingService.countTokensApprox(sectionText) <= chunkSize) {
      result.push(sectionText.trim());
      continue;
    }
    const h3Sections = splitByH3(h2.content);
    const hasH3 = h3Sections.some((s) => s.title);
    if (hasH3) {
      for (const h3 of h3Sections) {
        const cleanedH3 = markdownToPlainText(h3.content);
        if (chunkingService.countTokensApprox(cleanedH3) < MIN_CONTENT_TOKENS) continue;
        const titleParts = [h2.title, h3.title].filter(Boolean);
        const prefix = titleParts.join(" > ");
        const chunkText = prefix ? `${prefix}. ${cleanedH3}` : cleanedH3;
        if (chunkingService.countTokensApprox(chunkText) <= chunkSize) {
          result.push(chunkText.trim());
        } else {
          const subChunks = chunkingService.chunkText(cleanedH3, chunkSize, chunkOverlap);
          for (const chunk of subChunks) {
            result.push(prefix ? `${prefix}. ${chunk}` : chunk);
          }
        }
      }
    } else {
      const subChunks = chunkingService.chunkText(cleanedContent, chunkSize, chunkOverlap);
      for (const chunk of subChunks) {
        result.push(h2.title ? `${h2.title}. ${chunk}` : chunk);
      }
    }
  }
  return result.filter((c) => c.trim().length > 0);
}
var NoteIndexer = class {
  constructor(app, chunkingService, embeddingService, vectorStore) {
    this.app = app;
    this.chunkingService = chunkingService;
    this.embeddingService = embeddingService;
    this.vectorStore = vectorStore;
  }
  async indexFile(file, settings, signal) {
    const storedMtime = this.vectorStore.getFileMtime(file.path);
    if (storedMtime === file.stat.mtime) {
      return { vaultPath: file.path, skipped: true, chunkCount: 0, pageCount: 0 };
    }
    const raw = await this.app.vault.read(file);
    const withoutFrontmatter = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
    if (!withoutFrontmatter) {
      this.vectorStore.upsertFile(file.path, file.stat.mtime, []);
      return { vaultPath: file.path, skipped: false, chunkCount: 0, pageCount: 0 };
    }
    const chunkTexts = chunkMarkdownBySections(
      withoutFrontmatter,
      settings.chunkSize,
      settings.chunkOverlap,
      this.chunkingService
    );
    const chunks = chunkTexts.map((text, idx) => ({
      id: `${file.path}::p0::c${idx}`,
      text,
      embedding: [],
      sourceType: "note",
      vaultPath: file.path,
      page: 0,
      chunkIndex: idx
    }));
    if (signal?.aborted) throw new Error("Indexing aborted");
    if (chunks.length > 0) {
      const embeddings = await this.embeddingService.embedBatch(chunks.map((c) => c.text));
      chunks.forEach((c, i) => {
        c.embedding = embeddings[i];
      });
    }
    this.vectorStore.upsertFile(file.path, file.stat.mtime, chunks);
    return { vaultPath: file.path, skipped: false, chunkCount: chunks.length, pageCount: 0 };
  }
};

// src/indexer/IndexManager.ts
var IndexManager = class {
  constructor(app, chunkingService, embeddingService, vectorStore, pdfIndexer, noteIndexer) {
    this.app = app;
    this.chunkingService = chunkingService;
    this.embeddingService = embeddingService;
    this.vectorStore = vectorStore;
    this.pdfIndexer = pdfIndexer ?? new PDFIndexer(app, chunkingService, embeddingService, vectorStore);
    this.noteIndexer = noteIndexer ?? new NoteIndexer(app, chunkingService, embeddingService, vectorStore);
  }
  getFilesToIndex(scope) {
    const files = this.app.vault.getFiles();
    if (scope === "pdfs-only") {
      return files.filter((f) => f.extension === "pdf");
    }
    return files.filter((f) => f.extension === "pdf" || f.extension === "md");
  }
  async indexAll(settings, onProgress, signal) {
    await this.vectorStore.ensureLoaded(settings.embeddingModel);
    const files = this.getFilesToIndex(settings.indexScope);
    const result = { indexed: 0, skipped: 0, failed: 0, warnings: [] };
    let saveCounter = 0;
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) break;
      const file = files[i];
      onProgress?.(i + 1, files.length, file.name);
      try {
        let fileResult;
        if (file.extension === "pdf") {
          fileResult = await this.pdfIndexer.indexFile(file, settings, void 0, signal);
        } else {
          fileResult = await this.noteIndexer.indexFile(file, settings, signal);
        }
        if (fileResult.skipped) {
          result.skipped++;
        } else {
          result.indexed++;
          if (fileResult.warningScannedPdf) {
            result.warnings.push(`'${file.name}' may be scanned \u2014 no text layer found on most pages.`);
          }
        }
      } catch (err) {
        if (err.message === "Indexing aborted") break;
        console.error(`Failed to index ${file.path}:`, err);
        result.failed++;
      }
      saveCounter++;
      if (saveCounter % 10 === 0) {
        await this.vectorStore.save();
      }
    }
    await this.vectorStore.save();
    return result;
  }
  async indexCurrentFile(file, settings) {
    await this.vectorStore.ensureLoaded(settings.embeddingModel);
    const result = { indexed: 0, skipped: 0, failed: 0, warnings: [] };
    try {
      let fileResult;
      if (file.extension === "pdf") {
        fileResult = await this.pdfIndexer.indexFile(file, settings);
      } else {
        fileResult = await this.noteIndexer.indexFile(file, settings);
      }
      if (fileResult.skipped) result.skipped++;
      else result.indexed++;
      if (fileResult.warningScannedPdf) result.warnings.push(`'${file.name}' may be scanned.`);
    } catch (err) {
      result.failed++;
    }
    await this.vectorStore.save();
    return result;
  }
  async removeFile(vaultPath) {
    this.vectorStore.removeFile(vaultPath);
    await this.vectorStore.save();
  }
};

// src/ui/RagView.ts
var import_obsidian5 = require("obsidian");
var VIEW_TYPE_RAG_CHAT = "rag-chat";
var RagView = class extends import_obsidian5.ItemView {
  constructor(leaf, chatService, settings) {
    super(leaf);
    this.chatService = chatService;
    this.settings = settings;
    this.turns = [];
    this.abortController = null;
  }
  getViewType() {
    return VIEW_TYPE_RAG_CHAT;
  }
  getDisplayText() {
    return "RAG Chat";
  }
  getIcon() {
    return "message-square";
  }
  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("rag-view");
    this.messagesEl = container.createEl("div", { cls: "rag-messages" });
    const inputArea = container.createEl("div", { cls: "rag-input-area" });
    this.inputEl = inputArea.createEl("textarea", {
      cls: "rag-chat-input",
      attr: { placeholder: "Ask a question\u2026 (Shift+Enter for new line)", rows: "3" }
    });
    const btnRow = inputArea.createEl("div", { cls: "rag-btn-row" });
    this.sendBtn = btnRow.createEl("button", { cls: "rag-send-btn", text: "Send" });
    const clearBtn = btnRow.createEl("button", { cls: "rag-clear-btn", text: "Clear chat" });
    this.sendBtn.addEventListener("click", () => this.handleSend());
    clearBtn.addEventListener("click", () => this.clearChat());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
    for (const turn of this.turns) {
      await this.renderTurn(turn);
    }
    this.scrollToBottom();
    this.inputEl.focus();
  }
  async onClose() {
    this.abortController?.abort();
  }
  async handleSend() {
    const question = this.inputEl.value.trim();
    if (!question || this.sendBtn.disabled) return;
    this.inputEl.value = "";
    this.setLoading(true);
    const userTurn = {
      id: `u-${Date.now()}`,
      role: "user",
      displayContent: question,
      sources: []
    };
    this.turns.push(userTurn);
    await this.renderTurn(userTurn);
    const assistantTurn = {
      id: `a-${Date.now()}`,
      role: "assistant",
      displayContent: "",
      sources: [],
      isStreaming: true
    };
    this.turns.push(assistantTurn);
    const assistantEl = this.messagesEl.createEl("div", {
      cls: "rag-message rag-message-assistant rag-message-streaming"
    });
    const statusEl = assistantEl.createEl("div", { cls: "rag-stream-status is-waiting" });
    statusEl.textContent = "Waiting for response\u2026";
    const contentEl = assistantEl.createEl("div", { cls: "rag-message-content" });
    this.abortController = new AbortController();
    try {
      const result = await this.chatService.ask(
        question,
        this.abortController.signal,
        this.settings.streamingEnabled ? (visible, state) => {
          if (state === "thinking") {
            statusEl.textContent = "Thinking\u2026";
            statusEl.className = "rag-stream-status is-thinking";
            contentEl.textContent = "";
          } else {
            statusEl.className = "rag-stream-status is-responding";
            statusEl.textContent = "";
            contentEl.textContent = visible;
          }
          this.scrollToBottom();
        } : void 0
      );
      assistantTurn.displayContent = result.displayContent;
      assistantTurn.sources = result.sources;
      assistantTurn.isStreaming = false;
      assistantEl.remove();
      await this.renderTurn(assistantTurn);
    } catch (err) {
      assistantTurn.isStreaming = false;
      const msg = this.getErrorMessage(err);
      if (msg) {
        assistantTurn.displayContent = msg;
        assistantEl.classList.remove("rag-message-streaming");
        assistantEl.classList.add("rag-message-error");
        statusEl.remove();
        contentEl.textContent = msg;
      } else {
        this.turns.pop();
        assistantEl.remove();
      }
    } finally {
      this.setLoading(false);
      this.inputEl.focus();
    }
  }
  async renderTurn(turn) {
    const el = this.messagesEl.createEl("div", {
      cls: `rag-message rag-message-${turn.role}`
    });
    if (turn.role === "user") {
      el.createEl("div", { cls: "rag-message-content", text: turn.displayContent });
    } else {
      const content = el.createEl("div", { cls: "rag-message-content" });
      await import_obsidian5.MarkdownRenderer.renderMarkdown(turn.displayContent, content, "", this);
      this.injectCitationLinks(content, turn.sources);
      if (turn.sources.length > 0) {
        this.renderSources(el, turn.sources);
      }
    }
    this.scrollToBottom();
    return el;
  }
  /**
   * After MarkdownRenderer produces HTML, walk text nodes and replace
   * [N] citation markers with clickable links (without closing the view).
   */
  injectCitationLinks(container, sources) {
    if (sources.length === 0) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) textNodes.push(node);
    for (const textNode of textNodes) {
      const text = textNode.textContent ?? "";
      if (!/\[\d+\]/.test(text)) continue;
      const parts = text.split(/\[(\d+)\]/);
      const frag = document.createDocumentFragment();
      parts.forEach((part, idx) => {
        if (idx % 2 === 0) {
          if (part) frag.appendChild(document.createTextNode(part));
        } else {
          const n = parseInt(part, 10);
          const source = sources[n - 1];
          if (source) {
            const a = document.createElement("a");
            a.className = "rag-citation-link";
            a.textContent = `[${n}]`;
            a.addEventListener("click", (e) => {
              e.preventDefault();
              this.app.workspace.openLinkText(source.obsidianLink, "");
            });
            frag.appendChild(a);
          } else {
            frag.appendChild(document.createTextNode(`[${n}]`));
          }
        }
      });
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }
  renderSources(container, sources) {
    const details = container.createEl("details", { cls: "rag-sources-details" });
    details.createEl("summary").textContent = `${sources.length} source${sources.length !== 1 ? "s" : ""}`;
    const list = details.createEl("ul", { cls: "rag-sources-list" });
    sources.forEach((source, idx) => {
      const link = list.createEl("li").createEl("a", { cls: "rag-source-link" });
      link.textContent = `[${idx + 1}] ${source.displayLabel}`;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        this.app.workspace.openLinkText(source.obsidianLink, "");
      });
    });
  }
  clearChat() {
    this.turns = [];
    this.messagesEl.empty();
    this.chatService.clearHistory();
  }
  setLoading(loading) {
    this.sendBtn.disabled = loading;
    this.inputEl.disabled = loading;
    this.sendBtn.textContent = loading ? "\u2026" : "Send";
  }
  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
  getErrorMessage(err) {
    if (err instanceof ProviderError) {
      switch (err.code) {
        case "CONNECTION_REFUSED":
          if (this.settings.chatProvider === "cli") {
            return "CLI command failed \u2014 check the CLI Command template in settings and use Test Connection to debug it.";
          }
          return `Cannot connect to ${this.settings.chatBaseUrl}. Is Ollama / LM Studio running?`;
        case "MODEL_NOT_FOUND":
          return `Model '${this.settings.chatModel}' not found \u2014 check settings.`;
        case "STREAM_ABORTED":
          return "";
        default:
          return `Provider error: ${err.message}`;
      }
    }
    if (err.name === "AbortError") return "";
    return `Error: ${err.message ?? "Unknown"}`;
  }
};

// src/ui/ChatService.ts
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
function visibleContent(accumulated) {
  let result = accumulated.replace(/<think>[\s\S]*?<\/think>/gi, "");
  result = result.replace(/<think>[\s\S]*$/i, "");
  return result.trim();
}
var ChatService = class {
  constructor(provider, vectorStore, embeddingService, citationService, settings) {
    this.provider = provider;
    this.vectorStore = vectorStore;
    this.embeddingService = embeddingService;
    this.citationService = citationService;
    this.settings = settings;
    /**
     * Conversation history for the LLM (user + assistant turns only).
     * The system message is regenerated on each turn with fresh RAG context.
     */
    this.conversationHistory = [];
  }
  hasIndexedContent() {
    return this.vectorStore.getStats().chunkCount > 0;
  }
  async ask(question, signal, onToken) {
    await this.vectorStore.ensureLoaded(this.settings.embeddingModel);
    if (!this.hasIndexedContent()) {
      return {
        displayContent: 'You have no indexed information.\n\nTo get started, open the command palette and run "RAG: Index all files" to index your PDFs and notes.',
        sources: []
      };
    }
    const queryEmbedding = await this.embeddingService.embedQuery(question);
    const results = this.vectorStore.query(queryEmbedding, this.settings.topK);
    const sources = results.map((r) => this.citationService.buildCitationSource(r.chunk, r.score));
    const context = this.citationService.formatContext(sources);
    const systemMsg = {
      role: "system",
      content: `You are a precise research assistant. Answer questions based ONLY on the provided source documents.
Always cite your sources using [N] notation where N is the source number.
If information is not in the provided sources, say so clearly.
Be concise and accurate.

SOURCE DOCUMENTS:
${context}`
    };
    const userMsg = { role: "user", content: question };
    const messages = [systemMsg, ...this.conversationHistory, userMsg];
    let rawAccumulated = "";
    const wrappedOnToken = onToken ? (token) => {
      rawAccumulated += token;
      const visible = visibleContent(rawAccumulated);
      const state = visible.length > 0 ? "responding" : "thinking";
      onToken(visible, state);
    } : void 0;
    const rawFull = await this.provider.chat(messages, signal, wrappedOnToken);
    if (!rawFull && !signal.aborted) {
      throw new ProviderError(
        `Model returned an empty response. The context built from ${sources.length} sources may be too large. Try reducing Top K in settings.`,
        "UNEXPECTED_RESPONSE"
      );
    }
    const validated = this.citationService.validateCitations(rawFull, sources);
    const displayContent = stripThinking(validated);
    this.conversationHistory.push(userMsg, { role: "assistant", content: rawFull });
    return { displayContent, sources };
  }
  clearHistory() {
    this.conversationHistory = [];
  }
};

// src/main.ts
var _RagPlugin = class _RagPlugin extends import_obsidian6.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
    this.indexAbortController = null;
    this.isIndexing = false;
    this.fileIndexDebounce = /* @__PURE__ */ new Map();
  }
  // 5 minutes
  async onload() {
    await this.loadSettings();
    const embedder = createEmbedder(this.settings, (0, import_path3.join)(
      this.app.vault.adapter.getBasePath(),
      this.manifest.dir ?? ""
    ));
    const chatProvider = createChatProvider(this.settings);
    this.vectorStore = new VectorStore(this.manifest.dir ?? "", this.app);
    const chunkingService = new ChunkingService();
    const embeddingService = new EmbeddingService(embedder);
    const citationService = new CitationService();
    this.chatService = new ChatService(
      chatProvider,
      this.vectorStore,
      embeddingService,
      citationService,
      this.settings
    );
    this.indexManager = new IndexManager(
      this.app,
      chunkingService,
      embeddingService,
      this.vectorStore
    );
    this.registerView(
      VIEW_TYPE_RAG_CHAT,
      (leaf) => new RagView(leaf, this.chatService, this.settings)
    );
    this.vectorStore.ensureLoaded(this.settings.embeddingModel).then(() => {
      if (this.vectorStore.schemaUpgraded) {
        new import_obsidian6.Notice(
          'RAG: Index format was updated \u2014 please run "RAG: Index all files" to re-index your documents.',
          0
          // stays until dismissed
        );
        return;
      }
      return this.vectorStore.exists().then((exists) => {
        if (!exists) {
          new import_obsidian6.Notice('RAG: No index found. Run "RAG: Index all files" to get started.', 8e3);
        }
      });
    }).catch((err) => {
      if (err instanceof ProviderError && err.code === "DIMENSION_MISMATCH") {
        new import_obsidian6.Notice('RAG: Embedding model changed \u2014 run "RAG: Index all files" to re-index.', 1e4);
      } else {
        console.error("RAG Plugin: Failed to load index:", err);
      }
    });
    this.addCommand({
      id: "rag-index-current-file",
      name: "Index current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (file.extension !== "pdf" && file.extension !== "md") return false;
        if (!checking) this.indexCurrentFile(file);
        return true;
      }
    });
    this.addCommand({
      id: "rag-index-all",
      name: "Index all files",
      callback: () => this.indexAll()
    });
    this.addCommand({
      id: "rag-cancel-index",
      name: "Cancel indexing",
      callback: () => {
        if (this.isIndexing) {
          this.indexAbortController?.abort();
          new import_obsidian6.Notice("RAG: Indexing cancelled.", 4e3);
        }
      }
    });
    this.addCommand({
      id: "rag-ask-question",
      name: "Ask a question",
      callback: () => this.openChatView()
    });
    this.addSettingTab(new RagSettingTab(this.app, this));
    this.registerEvent(
      this.app.vault.on("modify", (abstractFile) => {
        const file = abstractFile;
        if (!this.settings.autoIndexOnStartup) return;
        if (file.extension !== "pdf" && file.extension !== "md") return;
        const now = Date.now();
        const last = this.fileIndexDebounce.get(file.path) ?? 0;
        if (now - last < _RagPlugin.INDEX_DEBOUNCE_MS) return;
        this.fileIndexDebounce.set(file.path, now);
        this.indexCurrentFile(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (abstractFile) => {
        this.indexManager.removeFile(abstractFile.path).catch((err) => console.error("RAG: Remove file error:", err));
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (abstractFile, oldPath) => {
        this.indexManager.removeFile(oldPath).catch((err) => console.error("RAG: Rename cleanup error:", err));
      })
    );
    if (this.settings.autoIndexOnStartup) {
      setTimeout(() => this.indexAll(), 5e3);
    }
  }
  onunload() {
    this.indexAbortController?.abort();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_RAG_CHAT);
  }
  async indexAll() {
    if (this.isIndexing) {
      new import_obsidian6.Notice("RAG: Indexing already in progress.", 3e3);
      return;
    }
    this.isIndexing = true;
    this.indexAbortController = new AbortController();
    const notice = new import_obsidian6.Notice("RAG: Indexing\u2026 0 / ?", 0);
    try {
      const result = await this.indexManager.indexAll(
        this.settings,
        (current, total, filename) => {
          notice.setMessage(`RAG: Indexing\u2026 ${current} / ${total}  \u2014  ${filename}`);
        },
        this.indexAbortController.signal
      );
      notice.hide();
      const parts = [`${result.indexed} indexed`];
      if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
      if (result.failed > 0) parts.push(`${result.failed} failed`);
      new import_obsidian6.Notice(`RAG: Done \u2014 ${parts.join(", ")}.`, 5e3);
      if (result.warnings.length > 0) {
        new import_obsidian6.Notice(`RAG warnings: ${result.warnings.join("; ")}`, 8e3);
      }
    } catch (err) {
      notice.hide();
      const msg = err.message ?? "";
      if (msg !== "Indexing aborted") {
        new import_obsidian6.Notice(`RAG: Indexing failed \u2014 ${msg}`, 8e3);
      }
    } finally {
      this.isIndexing = false;
      this.indexAbortController = null;
    }
  }
  async indexCurrentFile(file) {
    try {
      const result = await this.indexManager.indexCurrentFile(file, this.settings);
      if (!result.skipped) {
        new import_obsidian6.Notice(`RAG: Indexed ${file.name}.`, 3e3);
      }
    } catch (err) {
      console.error("RAG: Index error:", err);
    }
  }
  async openChatView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_RAG_CHAT);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_RAG_CHAT, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrateLegacySettings(await this.loadData()));
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
_RagPlugin.INDEX_DEBOUNCE_MS = 5 * 60 * 1e3;
var RagPlugin = _RagPlugin;
