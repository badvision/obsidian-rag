"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => RagPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian6 = require("obsidian");
var import_path4 = require("path");

// src/settings.ts
var import_obsidian3 = require("obsidian");
var import_path3 = require("path");

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
    const { url, body, signal, headers: extraHeaders, onLine } = opts;
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
          "Content-Length": Buffer.byteLength(body),
          ...extraHeaders
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
function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : void 0;
}
var OllamaEmbedder = class {
  constructor(baseUrl, embeddingModel, apiKey) {
    this.baseUrl = baseUrl;
    this.embeddingModel = embeddingModel;
    this.auth = authHeaders(apiKey);
  }
  async embed(texts) {
    try {
      const response = await (0, import_obsidian.requestUrl)({
        url: `${this.baseUrl}/api/embed`,
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.auth },
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
          headers: { "Content-Type": "application/json", ...this.auth },
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
        headers: this.auth,
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
        headers: this.auth,
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
  constructor(baseUrl, chatModel, apiKey) {
    this.baseUrl = baseUrl;
    this.chatModel = chatModel;
    this.auth = authHeaders(apiKey);
  }
  async chat(messages, signal, onToken) {
    const body = JSON.stringify({ model: this.chatModel, messages, stream: true });
    let accumulated = "";
    try {
      await nodeStreamPost({
        url: `${this.baseUrl}/api/chat`,
        body,
        signal,
        headers: this.auth,
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
        headers: this.auth,
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
        headers: this.auth,
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
function authHeaders2(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : void 0;
}
var LMStudioEmbedder = class {
  constructor(baseUrl, embeddingModel, apiKey) {
    this.baseUrl = baseUrl;
    this.embeddingModel = embeddingModel;
    this.auth = authHeaders2(apiKey);
  }
  async embed(texts) {
    try {
      const response = await (0, import_obsidian2.requestUrl)({
        url: `${this.baseUrl}/v1/embeddings`,
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.auth },
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
        headers: this.auth,
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
        headers: this.auth,
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
  constructor(baseUrl, chatModel, apiKey) {
    this.baseUrl = baseUrl;
    this.chatModel = chatModel;
    this.auth = authHeaders2(apiKey);
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
        headers: this.auth,
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
        headers: this.auth,
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
        headers: this.auth,
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
function extractCliError(stdout) {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const plain = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const top = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    if (!top) continue;
    const message = top["message"] && typeof top["message"] === "object" ? top["message"] : null;
    for (const scope of [top, message]) {
      if (!scope) continue;
      if (scope["stopReason"] === "error") {
        const msg = typeof scope["errorMessage"] === "string" ? scope["errorMessage"] : "";
        if (msg.trim()) return msg.trim().slice(0, 300);
      }
    }
    for (const scope of [top, message]) {
      if (!scope) continue;
      for (const field of ["errorMessage", "error"]) {
        const candidate = scope[field];
        if (typeof candidate === "string" && candidate.trim()) plain.push(candidate.trim());
        else if (candidate && typeof candidate === "object") {
          const nested = candidate;
          const nestedMsg = typeof nested["message"] === "string" ? nested["message"] : "";
          if (nestedMsg.trim()) plain.push(nestedMsg.trim());
        }
      }
    }
  }
  return plain.length > 0 ? plain[plain.length - 1].slice(0, 300) : null;
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
    const stripNul = (s) => s.replace(/\u0000/g, "");
    const system = stripNul(messages.find((m) => m.role === "system")?.content ?? "");
    const question = stripNul([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
    const prompt = stripNul(messages.map((m) => m.content).join("\n\n"));
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
      const detail = extractCliError(result.stdout) ?? (result.stderr || result.stdout).trim().slice(0, 300);
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
var import_path2 = require("path");

// src/providers/onnx-process.ts
var import_path = require("path");
var import_fs = require("fs");
var import_child_process = require("child_process");
var TRANSFORMERS_CACHE_KEY = "transformers-cache";
var STDERR_TAIL = 8192;
var DISPOSE_TIMEOUT_MS = 5e3;
var KILL_TIMEOUT_MS = 2e3;
var READY_TIMEOUT_MS = 15e3;
var OnnxProcessError = class extends Error {
  constructor(message, code = null, signal = null, childDead = true) {
    super(message);
    this.code = code;
    this.signal = signal;
    this.childDead = childDead;
    this.name = "OnnxProcessError";
  }
};
var OnnxCreateCancelledError = class extends OnnxProcessError {
  constructor() {
    super("ONNX pipeline creation was cancelled", null, null, false);
  }
};
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function buildOnnxWorkerSource() {
  const worker = function onnxWorkerMain() {
    "use strict";
    let parentPort = null;
    try {
      const proc = process;
      if (proc.parentPort) parentPort = proc.parentPort;
    } catch (err) {
      parentPort = null;
    }
    if (parentPort === null) {
      try {
        const electron = require("electron");
        if (electron && typeof electron === "object" && electron.parentPort) {
          parentPort = electron.parentPort;
        }
      } catch (err) {
        parentPort = null;
      }
    }
    const send = (msg) => {
      if (parentPort) parentPort.postMessage(msg);
      else if (typeof process.send === "function") process.send(msg);
    };
    const onMessage = (cb) => {
      if (parentPort) parentPort.on("message", (e) => cb(e.data));
      else process.on("message", (raw) => cb(raw));
    };
    const failMessage = (e) => e instanceof Error ? e.message : String(e);
    let pipe = null;
    let loaded = false;
    let shuttingDown = false;
    let inflight = 0;
    let queue = Promise.resolve();
    const finishIfIdle = () => {
      if (shuttingDown && inflight === 0) {
        send({ t: "disposed" });
        process.exit(0);
      }
    };
    const runLoad = (msg) => {
      const tfRequire = require("module").createRequire(
        require("path").join(msg.pluginDir, "main.js")
      );
      return Promise.resolve().then(() => tfRequire("@huggingface/transformers")).then((tf) => {
        const mod = tf;
        mod.env.cacheDir = msg.cacheDir;
        const opts = {
          device: msg.device,
          dtype: msg.dtype,
          progress_callback: (p) => {
            const event = p;
            if (event && event.status === "progress" && typeof event.file === "string" && event.file) {
              const pct = typeof event.progress === "number" ? Math.round(event.progress) : 0;
              send({
                t: "progress",
                message: `Downloading ${event.file} for ${msg.model}: ${pct}%`
              });
            }
          }
        };
        if (msg.device === "cpu") opts.session_options = { enableCpuMemArena: false };
        if (msg.subfolder !== void 0) opts.subfolder = msg.subfolder;
        if (msg.model_file_name !== void 0) opts.model_file_name = msg.model_file_name;
        return mod.pipeline("feature-extraction", msg.model, opts);
      }).then((pl) => {
        pipe = pl;
        loaded = true;
        send({ t: "loaded" });
        finishIfIdle();
      }).catch((err) => {
        send({ t: "error", message: failMessage(err) });
      });
    };
    const runInfer = (msg) => {
      inflight += 1;
      return Promise.resolve().then(() => {
        if (!pipe || !loaded) throw new Error("Model not loaded");
        return pipe(msg.text, msg.options ?? {});
      }).then((out) => {
        const arr = out && out.data;
        if (!arr || typeof arr !== "object" && typeof arr !== "function") {
          throw new Error("Pipeline returned no data");
        }
        const f32 = arr instanceof Float32Array ? arr : (
          // Tensor-backed ArrayLike coming back from transformers.js.
          Float32Array.from(arr)
        );
        if (parentPort) {
          send({ t: "result", id: msg.id, data: f32 });
        } else {
          send({
            t: "result",
            id: msg.id,
            b64: Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString("base64")
          });
        }
      }).catch((err) => {
        send({ t: "error", id: msg.id, message: failMessage(err) });
      }).then(() => {
        inflight -= 1;
        finishIfIdle();
      });
    };
    onMessage((raw) => {
      if (!raw || typeof raw !== "object") return;
      const msg = raw;
      if (msg.t === "load") {
        queue = queue.then(() => runLoad(msg));
      } else if (msg.t === "infer") {
        queue = queue.then(() => runInfer(msg));
      } else if (msg.t === "dispose") {
        shuttingDown = true;
        queue = queue.then(() => {
          send({ t: "disposed" });
          process.exit(0);
        });
      }
    });
    send({ t: "ready" });
  };
  return `('use strict');
(${worker.toString()})();
`;
}
async function seedModelFilesFromBrowserCache(pluginDir, model, signal) {
  const globalWithCaches = globalThis;
  const cachesGlobal = globalWithCaches.caches;
  if (!cachesGlobal) return;
  if (signal?.aborted) {
    throw new OnnxProcessError("Model cache seeding was cancelled");
  }
  const cacheDir = (0, import_path.join)(pluginDir, "models");
  let cache;
  try {
    cache = await cachesGlobal.open(TRANSFORMERS_CACHE_KEY);
  } catch (err) {
    return;
  }
  const prefix = `/${model}/resolve/`;
  const keys = await cache.keys();
  for (const key of keys) {
    if (signal?.aborted) {
      throw new OnnxProcessError("Model cache seeding was cancelled");
    }
    let rel;
    try {
      const url = new URL(key.url);
      if (!url.pathname.startsWith(prefix)) continue;
      const rest = url.pathname.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) continue;
      const revision = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      if (!file || file.includes("\0")) continue;
      rel = revision === "main" ? file : `${revision}/${file}`;
    } catch (err) {
      continue;
    }
    if (rel.includes("\0") || rel.includes("..")) continue;
    const dest = (0, import_path.join)(cacheDir, model, rel);
    let resp;
    try {
      resp = await cache.match(key);
    } catch (err) {
      continue;
    }
    if (!resp) continue;
    const expected = Number(resp.headers.get("content-length") ?? -1);
    try {
      if (expected >= 0 && (0, import_fs.existsSync)(dest) && (0, import_fs.statSync)(dest).size === expected) continue;
    } catch (err) {
    }
    const tmp = `${dest}.part-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      (0, import_fs.mkdirSync)((0, import_path.dirname)(dest), { recursive: true });
      await streamToFile(resp.body, tmp, signal);
      (0, import_fs.renameSync)(tmp, dest);
    } catch (err) {
      try {
        if ((0, import_fs.existsSync)(tmp)) (0, import_fs.unlinkSync)(tmp);
      } catch (cleanupErr) {
      }
      throw new OnnxProcessError(
        `Failed to seed cached model file '${rel}' for '${model}': ${errorMessage(err)}`
      );
    }
  }
}
async function streamToFile(body, dest, signal) {
  await new Promise((resolve, reject) => {
    const out = (0, import_fs.createWriteStream)(dest);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(err);
    };
    out.on("error", fail);
    out.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    if (!body) {
      out.end();
      return;
    }
    const reader = body.getReader();
    const pump = async () => {
      try {
        for (; ; ) {
          if (signal?.aborted) {
            throw new OnnxProcessError("Model cache seeding was cancelled");
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (!out.write(value)) {
            await new Promise((r) => {
              out.once("drain", () => r());
              out.once("error", () => r());
            });
          }
        }
        out.end();
      } catch (err) {
        fail(err);
      } finally {
        reader.cancel().catch(() => {
        });
        reader.releaseLock();
      }
    };
    void pump();
  });
}
function writeWorkerFile(cacheDir, source) {
  (0, import_fs.mkdirSync)(cacheDir, { recursive: true });
  const name = `.onnx-worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.cjs`;
  const workerPath = (0, import_path.join)(cacheDir, name);
  (0, import_fs.writeFileSync)(workerPath, source, "utf8");
  return workerPath;
}
function resolveUtilityProcess() {
  try {
    const electron = require("electron");
    const up = electron?.remote?.require?.("electron")?.utilityProcess;
    if (up) return up;
  } catch (err) {
  }
  try {
    const remote = require("@electron/remote");
    const up = remote?.require?.("electron")?.utilityProcess ?? remote?.utilityProcess;
    if (up) return up;
  } catch (err) {
  }
  return null;
}
function spawnWorker(workerPath) {
  if (process.versions.electron) {
    const up = resolveUtilityProcess();
    if (!up) {
      throw new OnnxProcessError(
        'Cannot isolate ONNX inference: Electron utilityProcess is unavailable (require("electron").remote). A child process is required; refusing to run ONNX in the renderer.'
      );
    }
    return up.fork(workerPath, [], {
      stdio: "pipe",
      serviceName: "Obsidian RAG embeddings",
      allowLoadingUnsignedLibraries: true
    });
  }
  const child = (0, import_child_process.fork)(workerPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"]
  });
  return {
    postMessage: (msg) => {
      child.send(msg);
    },
    on: (type, cb) => child.on(type, cb),
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => child.kill(signal),
    removeAllListeners: () => child.removeAllListeners(),
    get pid() {
      return child.pid;
    }
  };
}
var ProcessPipelineHost = class {
  constructor(onProgress) {
    this.child = null;
    this.workerPath = null;
    this.disposed = false;
    this.dead = false;
    this.exitInfo = null;
    this.stderrTail = "";
    this.nextId = 1;
    this.pending = /* @__PURE__ */ new Map();
    this.readySettled = false;
    this.loadSettled = false;
    this.readyResolve = null;
    this.readyReject = null;
    this.loadResolve = null;
    this.loadReject = null;
    this.exitWaiters = [];
    this.readyPromise = null;
    this.loadPromise = null;
    this.onProgress = onProgress ?? null;
  }
  /** Live child pid. For utilityProcess it is undefined until 'spawn'. */
  get pid() {
    return this.child ? this.child.pid : void 0;
  }
  /**
   * Resolves when the child signals ready (bootstrap + IPC handshake only —
   * no model work). Rejects if the child dies or fails to start.
   */
  waitForReady() {
    if (!this.readyPromise) {
      this.readyPromise = new Promise((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
    }
    return this.readyPromise;
  }
  /**
   * Resolves when the model is loaded in the child. Deliberately no hard
   * timeout: first-use downloads and session creation can legitimately run
   * for a long time. Rejects only on child death or a reported load error.
   */
  waitForLoad() {
    if (!this.loadPromise) {
      this.loadPromise = new Promise((resolve, reject) => {
        this.loadResolve = resolve;
        this.loadReject = reject;
      });
    }
    return this.loadPromise;
  }
  attach(child, workerPath) {
    this.child = child;
    this.workerPath = workerPath;
    child.on("message", (raw) => {
      this.handleMessage(raw);
    });
    child.on("exit", (code, signal) => this.onExit(toNullableNumber(code), toSignal(signal)));
    child.on("error", (first, ...rest) => {
      const detail = first instanceof Error ? first.message : [first, ...rest].map(String).filter(Boolean).join(" | ");
      this.fail(new OnnxProcessError(`Embedding child process error: ${detail || "unknown"}`));
    });
    child.stdout?.on("data", () => {
    });
    child.stderr?.on("data", (chunk) => this.tail(chunk));
  }
  infer(text, options) {
    if (this.disposed) {
      return Promise.reject(new OnnxProcessError("Embedding pipeline has been disposed"));
    }
    if (this.dead) {
      return Promise.reject(
        new OnnxProcessError(
          `Embedding child process is not running (code=${this.exitInfo?.code ?? "null"}, signal=${this.exitInfo?.signal ?? "null"})`,
          this.exitInfo?.code ?? null,
          this.exitInfo?.signal ?? null
        )
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.postMessage({ t: "infer", id, text, options: options ?? {} });
      } catch (err) {
        this.pending.delete(id);
        reject(new OnnxProcessError(`Failed to send inference request: ${errorMessage(err)}`));
      }
    });
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (!child || this.dead) {
      this.dead = true;
      this.cleanup();
      return;
    }
    try {
      child.postMessage({ t: "dispose" });
    } catch (err) {
    }
    await Promise.race([this.waitForExit(), delay(DISPOSE_TIMEOUT_MS)]);
    if (!this.dead) {
      const pid = child.pid;
      if (typeof pid === "number") {
        try {
          process.kill(pid, "SIGKILL");
        } catch (err) {
        }
      }
      try {
        child.kill("SIGKILL");
      } catch (err) {
      }
      await Promise.race([this.waitForExit(), delay(KILL_TIMEOUT_MS)]);
    }
    this.dead = true;
    this.cleanup();
  }
  /** Reject ready/load and every pending infer (first failure wins). */
  fail(err) {
    if (!this.readySettled) {
      this.readySettled = true;
      this.readyReject?.(err);
    }
    if (!this.loadSettled) {
      this.loadSettled = true;
      this.loadReject?.(err);
    }
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(err);
    }
  }
  onExit(code, signal) {
    this.exitInfo = { code, signal };
    if (!this.disposed && (code !== 0 || signal !== null)) {
      const tail = this.stderrTail.trim();
      this.fail(
        new OnnxProcessError(
          `Embedding child process exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})${tail ? `. Last stderr: ${tail}` : ""}`,
          code,
          signal
        )
      );
    }
    this.removeWorkerFile();
    this.dead = true;
    this.child = null;
    for (const waiter of this.exitWaiters.splice(0)) waiter();
  }
  handleMessage(raw) {
    if (!raw || typeof raw !== "object") return;
    const msg = raw;
    if (msg.t === "ready") {
      if (!this.readySettled) {
        this.readySettled = true;
        this.readyResolve?.();
      }
    } else if (msg.t === "loaded") {
      if (!this.loadSettled) {
        this.loadSettled = true;
        this.loadResolve?.();
      }
    } else if (msg.t === "progress") {
      if (typeof msg.message === "string") this.onProgress?.(msg.message);
    } else if (msg.t === "result") {
      const id = msg.id;
      if (typeof id !== "number") return;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      p.resolve({ data: decodeVector(msg) });
    } else if (msg.t === "error") {
      const message = typeof msg.message === "string" ? msg.message : "unknown child error";
      const id = msg.id;
      if (typeof id === "number") {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.reject(new OnnxProcessError(message, null, null, false));
        }
      } else if (!this.loadSettled) {
        this.loadSettled = true;
        this.loadReject?.(new OnnxProcessError(message));
      }
    } else if (msg.t === "disposed") {
      this.dead = true;
    }
  }
  tail(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL);
  }
  waitForExit() {
    if (this.dead) return Promise.resolve();
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }
  /** Remove the worker script; idempotent. Called on every child exit. */
  removeWorkerFile() {
    if (!this.workerPath) return;
    const workerPath = this.workerPath;
    this.workerPath = null;
    try {
      if ((0, import_fs.existsSync)(workerPath)) (0, import_fs.unlinkSync)(workerPath);
    } catch (err) {
    }
  }
  cleanup() {
    try {
      this.child?.removeAllListeners?.();
    } catch (err) {
    }
    this.child = null;
    this.removeWorkerFile();
    for (const [, p] of this.pending) {
      p.reject(new OnnxProcessError("Embedding pipeline disposed before the request completed"));
    }
    this.pending.clear();
  }
};
function toNullableNumber(v) {
  return v === null || v === void 0 ? null : Number(v);
}
function toSignal(v) {
  return typeof v === "string" ? v : null;
}
function decodeVector(msg) {
  const { data, b64 } = msg;
  if (data instanceof Float32Array) return data;
  if (typeof b64 === "string") {
    const buf = Buffer.from(b64, "base64");
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  }
  if (!data) {
    throw new OnnxProcessError("Malformed inference result from child process");
  }
  return Float32Array.from(data);
}
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && timer !== null) {
      const nodeTimer = timer;
      nodeTimer.unref?.();
    }
  });
}
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new OnnxProcessError(message)), ms);
    if (typeof timer === "object" && timer !== null) {
      const nodeTimer = timer;
      nodeTimer.unref?.();
    }
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
function aborted(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    const fail = () => reject(new OnnxCreateCancelledError());
    if (signal.aborted) {
      queueMicrotask(fail);
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}
function raceAbort(promise, signal) {
  if (!signal) return promise;
  return Promise.race([promise, aborted(signal)]);
}
async function createOnnxProcessPipeline(opts) {
  if (!opts.pluginDir) {
    throw new OnnxProcessError(
      "pluginDir is required to locate the model cache and worker dependencies"
    );
  }
  const cacheDir = (0, import_path.join)(opts.pluginDir, "models");
  if (opts.signal?.aborted) {
    throw new OnnxCreateCancelledError();
  }
  await seedModelFilesFromBrowserCache(opts.pluginDir, opts.model, opts.signal);
  let workerPath;
  try {
    workerPath = writeWorkerFile(cacheDir, opts.workerSource ?? buildOnnxWorkerSource());
  } catch (err) {
    throw new OnnxProcessError(
      `Failed to write ONNX worker script: ${errorMessage(err)}`
    );
  }
  let spawned;
  try {
    spawned = spawnWorker(workerPath);
  } catch (err) {
    try {
      (0, import_fs.unlinkSync)(workerPath);
    } catch (cleanupErr) {
    }
    throw err instanceof OnnxProcessError ? err : new OnnxProcessError(
      `Failed to start embedding child process: ${errorMessage(err)}`
    );
  }
  const host = new ProcessPipelineHost(opts.onProgress);
  host.attach(spawned, workerPath);
  try {
    await raceAbort(
      withTimeout(host.waitForReady(), READY_TIMEOUT_MS, "Embedding child process did not become ready"),
      opts.signal
    );
    const loadMsg = {
      t: "load",
      pluginDir: opts.pluginDir,
      cacheDir,
      model: opts.model,
      device: opts.device,
      dtype: opts.dtype
    };
    if (opts.subfolder !== void 0) loadMsg.subfolder = opts.subfolder;
    if (opts.model_file_name !== void 0) loadMsg.model_file_name = opts.model_file_name;
    spawned.postMessage(loadMsg);
    await raceAbort(host.waitForLoad(), opts.signal);
  } catch (err) {
    await host.dispose().catch(() => {
    });
    throw err instanceof OnnxProcessError ? err : new OnnxProcessError(
      `Failed to load ONNX model in child process: ${errorMessage(err)}`
    );
  }
  const callable = (text, options) => host.infer(text, options);
  return Object.assign(callable, {
    dispose: () => host.dispose(),
    // Read live: a utilityProcess pid is only set after the 'spawn' event.
    get pid() {
      return host.pid;
    }
  });
}

// src/providers/onnx.ts
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
    this.processPipe = null;
    /** Cancels the in-flight pipeline creation (bounded) when dispose() runs. */
    this.creationController = null;
    /**
     * Monotonic generation. Each load captures it; only the current generation
     * may install `processPipe`, so a load that settles after a dispose (or a
     * newer load) cannot orphan a child or steal ownership of a live one.
     */
    this.generation = 0;
  }
  loadPipeline() {
    if (!this.pipePromise) {
      const gen = this.generation;
      const controller = new AbortController();
      this.creationController = controller;
      const promise = this.load(controller.signal, gen).then((pipe) => {
        this.options.onProgress?.(`Embedding model ready (${this.options.model})`);
        return pipe;
      }).catch((err) => {
        if (this.pipePromise === promise) {
          this.pipePromise = null;
          this.processPipe = null;
        }
        throw err;
      });
      this.pipePromise = promise;
    }
    return this.pipePromise;
  }
  async load(signal, gen) {
    const load = ONNX_MODELS[this.options.model]?.load;
    const dtypes = load?.dtype ? [load.dtype] : ["q8", "fp32"];
    const preferred = this.options.device ?? "cpu";
    const devices = preferred === "coreml" ? ["coreml", "cpu"] : ["cpu"];
    const fileOpts = this.fileOptions();
    if (this.options.loader) {
      let tf;
      try {
        tf = await this.options.loader();
        tf.env.cacheDir = (0, import_path2.join)(this.options.pluginDir, "models");
      } catch (err) {
        throw this.wrapLoadError(err);
      }
      let lastErr2 = null;
      for (const device of devices) {
        for (const dtype of dtypes) {
          try {
            return await this.buildPipeline(tf, { device, dtype, ...fileOpts });
          } catch (err) {
            lastErr2 = err;
            this.options.onProgress?.(
              `ONNX load failed (${device}/${dtype}), trying next variant: ${err.message}`
            );
          }
        }
      }
      throw this.wrapLoadError(lastErr2);
    }
    let lastErr = null;
    for (const device of devices) {
      for (const dtype of dtypes) {
        try {
          const pipe = await createOnnxProcessPipeline({
            pluginDir: this.options.pluginDir,
            model: this.options.model,
            device,
            dtype,
            ...fileOpts,
            onProgress: this.options.onProgress,
            signal
          });
          if (gen === this.generation) {
            this.processPipe = pipe;
          } else {
            await pipe.dispose().catch(() => {
            });
          }
          return pipe;
        } catch (err) {
          if (err instanceof OnnxCreateCancelledError) throw err;
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
  async buildPipeline(tf, opts) {
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
    const gen = this.generation;
    let pipe;
    try {
      pipe = await this.loadPipeline();
    } catch (err) {
      if (err instanceof OnnxCreateCancelledError) {
        throw new ProviderError("Embedding model load was cancelled", "STREAM_ABORTED", err);
      }
      throw err;
    }
    const embeddings = [];
    for (const text of texts) {
      let out;
      try {
        out = await pipe(text, { pooling: "mean", normalize: true });
      } catch (err) {
        if (err instanceof OnnxProcessError && err.childDead && gen === this.generation) {
          this.pipePromise = null;
          this.processPipe = null;
        }
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
   * Release the embedding pipeline: terminates the isolated child process and
   * frees the loaded model. Idempotent; a later embed()/ping() starts a fresh
   * pipeline.
   */
  async dispose() {
    this.generation += 1;
    const controller = this.creationController;
    this.creationController = null;
    const inFlight = this.pipePromise;
    this.pipePromise = null;
    const pipe = this.processPipe;
    this.processPipe = null;
    controller?.abort();
    if (pipe) {
      try {
        await pipe.dispose();
      } catch (err) {
      }
    }
    if (inFlight) {
      await Promise.race([inFlight, delayMs(8e3)]).catch(() => {
      });
    }
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
function delayMs(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && timer !== null) {
      timer.unref?.();
    }
  });
}

// src/providers/factory.ts
function createEmbedder(settings, pluginDir, onProgress) {
  if (settings.embeddingProvider === "lmstudio") {
    return new LMStudioEmbedder(settings.embeddingBaseUrl, settings.embeddingModel, settings.embeddingApiKey);
  }
  if (settings.embeddingProvider === "onnx") {
    return new OnnxEmbedder({
      model: settings.embeddingModel,
      pluginDir: pluginDir ?? "",
      onProgress,
      device: settings.onnxDevice
    });
  }
  return new OllamaEmbedder(settings.embeddingBaseUrl, settings.embeddingModel, settings.embeddingApiKey);
}
function createChatProvider(settings) {
  if (settings.chatProvider === "lmstudio") {
    return new LMStudioChatProvider(settings.chatBaseUrl, settings.chatModel, settings.chatApiKey);
  }
  if (settings.chatProvider === "cli") {
    return new CliChatProvider(settings.cliTemplate);
  }
  return new OllamaChatProvider(settings.chatBaseUrl, settings.chatModel, settings.chatApiKey);
}

// src/settings.ts
var DEFAULT_SETTINGS = {
  embeddingProvider: "ollama",
  embeddingBaseUrl: "http://localhost:11434",
  embeddingApiKey: "",
  embeddingModel: "nomic-embed-text",
  onnxDevice: "cpu",
  chatProvider: "ollama",
  chatBaseUrl: "http://localhost:11434",
  chatApiKey: "",
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
    this.statusTimer = null;
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
    }).finally(() => {
      void provider.dispose?.().catch(() => {
      });
    });
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    if (this.statusTimer !== null) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    containerEl.createEl("h2", { text: "RAG Plugin Settings" });
    containerEl.createEl("h3", { text: "Embeddings" });
    new import_obsidian3.Setting(containerEl).setName("Embedding Provider").setDesc("Provider used to build the semantic index").addDropdown(
      (dd) => dd.addOption("ollama", "Ollama").addOption("lmstudio", "LM Studio / MLX").addOption("onnx", "Managed local ONNX worker (no server)").setValue(this.plugin.settings.embeddingProvider).onChange(async (value) => {
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
      new import_obsidian3.Setting(containerEl).setName("Embedding API Key").setDesc("Optional. Sent as a Bearer token \u2014 for remote Ollama / LM Studio endpoints that require auth").addText(
        (text) => text.setValue(this.plugin.settings.embeddingApiKey).onChange(async (value) => {
          this.plugin.settings.embeddingApiKey = value;
          await this.plugin.saveSettings();
        })
      );
    }
    this.addModelDropdown(
      containerEl,
      "Embedding Model",
      "Model for embeddings \u2014 changing this requires a full re-index",
      createEmbedder(this.plugin.settings, (0, import_path3.join)(
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
        `Model downloads on first use (~20-150 MB) and is cached at ${this.plugin.manifest?.dir ?? ".obsidian/plugins/obsidian-rag"}/models/. No server or network needed afterwards. Inference runs in a managed local worker \u2014 first use of a model takes a few seconds.`
      );
      new import_obsidian3.Setting(containerEl).setName("ONNX Device").setDesc(
        "Where inference runs. CoreML uses Apple Silicon (GPU/ANE) where available; if a model is unsupported there it automatically falls back to CPU."
      ).addDropdown(
        (dd) => dd.addOption("cpu", "CPU (safe, portable)").addOption("coreml", "CoreML \u2014 Apple GPU/ANE").setValue(this.plugin.settings.onnxDevice).onChange(async (value) => {
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
      new import_obsidian3.Setting(containerEl).setName("Chat API Key").setDesc("Optional. Sent as a Bearer token \u2014 for remote Ollama / LM Studio endpoints that require auth").addText(
        (text) => text.setValue(this.plugin.settings.chatApiKey).onChange(async (value) => {
          this.plugin.settings.chatApiKey = value;
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
        let embedder = null;
        try {
          embedder = createEmbedder(
            this.plugin.settings,
            (0, import_path3.join)(this.app.vault.adapter.getBasePath(), this.plugin.manifest?.dir ?? ""),
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
          void embedder?.dispose?.().catch(() => {
          });
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
    new import_obsidian3.Setting(containerEl).setName("Index Location").setDesc(`Stored at: ${this.plugin.manifest?.dir ?? ".obsidian/plugins/obsidian-rag"}/index/index.gcf`);
    const statusSetting = new import_obsidian3.Setting(containerEl).setName("Index Status").setDesc("");
    statusSetting.addButton(
      (btn) => btn.setButtonText("Clear").onClick(async () => {
        if (confirm("Clear the entire document index? This cannot be undone.")) {
          await this.plugin.clearIndex();
          new import_obsidian3.Notice('Index cleared. Run "RAG: Index all files" to re-index.');
          void this.refreshIndexStatus(statusSetting);
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
        void this.refreshIndexStatus(statusSetting);
      })
    );
    this.refreshIndexStatus(statusSetting);
  }
  /**
   * Render the live index status into the "Index Status" row: in-flight run,
   * then queued work, then the last published index (counts + when). The
   * counts come from a bounded disk peek (header scalars + summary trailer)
   * — the query DB is never loaded for this. Refreshes on an interval while
   * the tab is open because an index pass can take minutes.
   */
  async refreshIndexStatus(statusSetting) {
    let summary;
    try {
      summary = await this.indexStatusSummary();
    } catch (err) {
      summary = `Index status unavailable \u2014 ${err.message ?? "unknown error"}`;
    }
    statusSetting.descEl?.setText(summary);
    if (typeof window === "undefined") return;
    if (this.statusTimer) window.clearInterval(this.statusTimer);
    this.statusTimer = window.setInterval(
      () => {
        void this.refreshIndexStatus(statusSetting);
      },
      5e3
    );
  }
  /** Current status text for the "Index Status" row (see refreshIndexStatus). */
  async indexStatusSummary() {
    const status = this.plugin.indexScheduler.getStatus();
    if (status.indexing) return "Indexing in progress\u2026";
    const queued = [];
    if (status.queued.clear) queued.push("clear");
    if (status.queued.fullPass) queued.push("full re-index");
    if (status.queued.changes > 0) queued.push(`${status.queued.changes} changed file${status.queued.changes === 1 ? "" : "s"}`);
    if (status.queued.removals > 0) queued.push(`${status.queued.removals} removal${status.queued.removals === 1 ? "" : "s"}`);
    if (queued.length > 0) {
      return `Queued (runs after the quiet window): ${queued.join(", ")}.`;
    }
    const stats = await this.plugin.vectorStore.peekStats();
    if (stats === null || stats.fileCount === 0 && stats.chunkCount === 0) {
      return "No index yet \u2014 run Re-index to build one.";
    }
    const parts = [
      `${stats.fileCount} file${stats.fileCount === 1 ? "" : "s"}`,
      `${stats.chunkCount} chunk${stats.chunkCount === 1 ? "" : "s"}`
    ];
    const last = status.lastRun;
    if (last && last.error) {
      return `Index is up to date \u2014 ${parts.join(", ")}. Last run ${(0, import_obsidian3.moment)(last.finishedAt).fromNow()} failed: ${last.error}`;
    }
    if (last && last.kind === "file") {
      return `Index is up to date \u2014 ${parts.join(", ")} (last: ${last.path ?? "one file"}, ${(0, import_obsidian3.moment)(last.finishedAt).fromNow()}).`;
    }
    if (last) {
      const run = [`${last.indexed} indexed`];
      if (last.skipped > 0) run.push(`${last.skipped} skipped`);
      if (last.failed > 0) run.push(`${last.failed} failed`);
      return `Index is up to date \u2014 ${parts.join(", ")} (last run ${(0, import_obsidian3.moment)(last.finishedAt).fromNow()}: ${run.join(", ")}).`;
    }
    return `Index is up to date \u2014 ${parts.join(", ")}, last indexed ${(0, import_obsidian3.moment)(stats.updatedAt).fromNow()}.`;
  }
};

// src/store/VectorStore.ts
var fs3 = __toESM(require("fs"));

// node_modules/@blackwell-systems/gcf/dist/constants.js
var KIND_EXPAND = {
  fn: "function",
  type: "type",
  method: "method",
  iface: "interface",
  var: "var",
  const: "const",
  resource: "resource",
  table: "table",
  class: "class",
  selector: "selector",
  field: "field",
  route: "route_handler",
  ext: "external",
  file: "file",
  pkg: "package",
  svc: "service"
};

// node_modules/@blackwell-systems/gcf/dist/scalar.js
var JSON_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
var NUMERIC_LIKE_RE = /^[+-]\.?\d|^\.\d|^0\d/;
var INLINE_ARRAY_RE = /\[[^\]]*\]\s*:/;
var I64_MIN = -9223372036854775808n;
var I64_MAX = 9223372036854775807n;
var MAX_SAFE = 9007199254740991n;
var currentLargeInt = "error";
function setLargeIntMode(mode) {
  currentLargeInt = mode;
}
function outOfRangeMessage(value) {
  return `out_of_range: integer ${value} is outside the canonical int64 domain [-9223372036854775808, 9223372036854775807]; model larger values as strings (SPEC 2.3.2)`;
}
function unsafeIntegerMessage(value) {
  return `unsafe_integer: integer ${value} exceeds the safe-integer range (2^53-1) of a JavaScript number; decode with largeInt 'string' | 'bigint' | 'number', or model the value as a string (SPEC 2.3.2)`;
}
function needsQuote(s) {
  if (s === "")
    return true;
  if (s === "-" || s === "~" || s === "^" || s === "true" || s === "false")
    return true;
  if (s.length >= 3 && s[0] === "^" && s[1] === "{" && s[s.length - 1] === "}")
    return true;
  if (JSON_NUMBER_RE.test(s))
    return true;
  if (NUMERIC_LIKE_RE.test(s))
    return true;
  if (s[0] === " " || s[s.length - 1] === " ")
    return true;
  if (s[0] === "#" || s[0] === "@" || s[0] === ".")
    return true;
  if (INLINE_ARRAY_RE.test(s))
    return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 92 || c < 32 || c === 10 || c === 13 || c === 124 || c === 44)
      return true;
    if (c >= 128 && c <= 159)
      return true;
    if (c > 127 && (c === 160 || c === 8232 || c === 8233 || c === 65279 || c === 5760 || c >= 8192 && c <= 8202 || c === 8239 || c === 8287 || c === 12288))
      return true;
  }
  return false;
}
function quoteString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 34:
        out += '\\"';
        break;
      case 92:
        out += "\\\\";
        break;
      case 8:
        out += "\\b";
        break;
      case 12:
        out += "\\f";
        break;
      case 10:
        out += "\\n";
        break;
      case 13:
        out += "\\r";
        break;
      case 9:
        out += "\\t";
        break;
      default:
        if (c < 32) {
          out += "\\u" + c.toString(16).padStart(4, "0");
        } else {
          out += s[i];
        }
    }
  }
  return out + '"';
}
function formatScalar(v, delimiter = 0) {
  if (v === null || v === void 0)
    return "-";
  if (typeof v === "boolean")
    return v ? "true" : "false";
  if (typeof v === "number")
    return formatNumber(v);
  if (typeof v === "bigint") {
    if (v < I64_MIN || v > I64_MAX)
      throw new Error(outOfRangeMessage(v.toString()));
    return v.toString();
  }
  const s = String(v);
  if (needsQuote(s) || delimiter && s.includes(String.fromCharCode(delimiter))) {
    return quoteString(s);
  }
  return s;
}
function formatNumber(f) {
  if (f === 0)
    return "0";
  const abs = Math.abs(f);
  if (abs >= 1e-6 && abs < 9007199254740992) {
    return toPreciseDecimal(f);
  }
  let s = f.toExponential();
  s = s.replace(/[eE]\+?0*(\d)/, "e+$1").replace(/[eE]-0*(\d)/, "e-$1");
  return s;
}
function toPreciseDecimal(f) {
  return String(f);
}
var BARE_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function isBareKey(s) {
  return BARE_KEY_RE.test(s);
}
function formatKey(s) {
  return isBareKey(s) ? s : quoteString(s);
}
function parseScalar(s, tabularContext) {
  if (s === "")
    return "";
  if (s[0] === '"')
    return parseQuotedString(s);
  if (s === "-")
    return null;
  if (s === "~") {
    if (!tabularContext)
      throw new Error("invalid_missing: ~ outside tabular row cell");
    return MISSING;
  }
  if (s === "^" || s.startsWith("^{") && s.endsWith("}")) {
    if (!tabularContext)
      throw new Error("invalid_attachment_marker: ^ outside tabular row cell");
    if (s === "^")
      return ATTACHMENT;
    return { __inlineSchema: s.slice(1) };
  }
  if (s === "true")
    return true;
  if (s === "false")
    return false;
  if (JSON_NUMBER_RE.test(s)) {
    if (!s.includes(".") && !s.includes("e") && !s.includes("E")) {
      const b = BigInt(s);
      if (b < I64_MIN || b > I64_MAX)
        throw new Error(outOfRangeMessage(s));
      if (b >= -MAX_SAFE && b <= MAX_SAFE)
        return Number(b);
      switch (currentLargeInt) {
        case "string":
          return s;
        case "bigint":
          return b;
        case "number":
          return Number(b);
        case "error":
        default:
          throw new Error(unsafeIntegerMessage(s));
      }
    }
    const f = Number(s);
    if (!isNaN(f))
      return f;
  }
  return s;
}
var MISSING = Symbol("missing");
var ATTACHMENT = Symbol("attachment");
function parseQuotedString(s) {
  if (s.length < 2 || s[0] !== '"')
    throw new Error("unterminated_quote");
  let out = "";
  let i = 1;
  while (i < s.length) {
    if (s[i] === '"') {
      if (i + 1 !== s.length)
        throw new Error("trailing_characters: after closing quote");
      return out;
    }
    if (s[i] === "\\") {
      if (i + 1 >= s.length)
        throw new Error("unterminated_quote");
      i++;
      switch (s[i]) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "	";
          break;
        case "u": {
          if (i + 4 >= s.length)
            throw new Error("invalid_escape: incomplete unicode");
          const hex = s.slice(i + 1, i + 5);
          const code = parseInt(hex, 16);
          if (isNaN(code))
            throw new Error(`invalid_escape: invalid unicode \\u${hex}`);
          if (code >= 55296 && code <= 56319) {
            if (i + 10 >= s.length || s[i + 5] !== "\\" || s[i + 6] !== "u") {
              throw new Error("invalid_surrogate: isolated high surrogate");
            }
            const hex2 = s.slice(i + 7, i + 11);
            const low = parseInt(hex2, 16);
            if (isNaN(low) || low < 56320 || low > 57343) {
              throw new Error("invalid_surrogate: invalid low surrogate");
            }
            out += String.fromCodePoint(65536 + (code - 55296) * 1024 + (low - 56320));
            i += 11;
            continue;
          }
          if (code >= 56320 && code <= 57343) {
            throw new Error("invalid_surrogate: isolated low surrogate");
          }
          out += String.fromCharCode(code);
          i += 5;
          continue;
        }
        default:
          throw new Error(`invalid_escape: unknown \\${s[i]}`);
      }
      i++;
      continue;
    }
    if (s.charCodeAt(i) < 32) {
      throw new Error(`invalid_escape: unescaped control U+${s.charCodeAt(i).toString(16).padStart(4, "0")}`);
    }
    out += s[i];
    i++;
  }
  throw new Error("unterminated_quote");
}
function splitRespectingQuotes(s, delim) {
  const parts = [];
  let current = "";
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    if (escaped) {
      current += s[i];
      escaped = false;
      continue;
    }
    if (s[i] === "\\" && inQuote) {
      current += s[i];
      escaped = true;
      continue;
    }
    if (s[i] === '"') {
      inQuote = !inQuote;
      current += s[i];
      continue;
    }
    if (s[i] === delim && !inQuote) {
      parts.push(current);
      current = "";
      continue;
    }
    current += s[i];
  }
  parts.push(current);
  return parts;
}
function splitFieldDecl(s) {
  if (s.length < 2 || s[0] !== "{")
    throw new Error("invalid field declaration");
  const closeIdx = findClosingBrace(s);
  if (closeIdx < 0)
    throw new Error("invalid field declaration");
  const inner = s.slice(1, closeIdx);
  if (!inner)
    return [];
  const raw = splitRespectingQuotes(inner, ",");
  const fields = [];
  const seen = /* @__PURE__ */ new Set();
  for (const f of raw) {
    const trimmed = f.trim();
    let name;
    if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
      name = parseQuotedString(trimmed);
    } else {
      if (!isBareKey(trimmed))
        throw new Error(`invalid field name: ${trimmed}`);
      name = trimmed;
    }
    if (seen.has(name))
      throw new Error(`duplicate_field_name: ${name}`);
    seen.add(name);
    fields.push(name);
  }
  return fields;
}
function findClosingBrace(s) {
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (s[i] === "\\" && inQuote) {
      escaped = true;
      continue;
    }
    if (s[i] === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (s[i] === "}" && !inQuote)
      return i;
  }
  return -1;
}

// node_modules/@blackwell-systems/gcf/dist/decode.js
function decode(input) {
  const lines = input.split("\n");
  if (lines.length === 0) {
    throw new Error("gcf: empty input");
  }
  const header = lines[0];
  if (!header.startsWith("GCF ")) {
    throw new Error(`gcf: invalid header, expected 'GCF ...' got "${header}"`);
  }
  const p = {
    tool: "",
    tokenBudget: 0,
    tokensUsed: 0,
    symbols: [],
    edges: []
  };
  parseHeader(header.slice(4), p);
  const isDelta = header.includes(" delta=true");
  const validDeltaSections = /* @__PURE__ */ new Set(["removed", "added", "edges_removed", "edges_added"]);
  const symbols = [];
  const symByID = /* @__PURE__ */ new Map();
  let currentDistance = 0;
  let inEdges = false;
  let declaredEdges = -1;
  let edgesDeclared = false;
  for (let i = 1; i < lines.length; i++) {
    let line = lines[i].replace(/\r$/, "");
    if (line === "")
      continue;
    if (line.startsWith("##! "))
      continue;
    if (line.startsWith("## ")) {
      let group = line.slice(3);
      let declaredCount = -1;
      const bracketIdx = group.indexOf(" [");
      if (bracketIdx >= 0) {
        const bracket = group.slice(bracketIdx + 2);
        group = group.slice(0, bracketIdx);
        const end = bracket.indexOf("]");
        if (end >= 0) {
          const cntStr = bracket.slice(0, end);
          if (cntStr !== "?") {
            const n = parseInt(cntStr, 10);
            if (isNaN(n))
              throw new Error(`count_mismatch: invalid section count "${cntStr}"`);
            declaredCount = n;
          }
        }
      }
      if (isDelta && !validDeltaSections.has(group)) {
        throw new Error(`malformed_delta: invalid delta section "${group}"`);
      }
      inEdges = group === "edges";
      if (inEdges && declaredCount >= 0) {
        declaredEdges = declaredCount;
        edgesDeclared = true;
      }
      if (!inEdges) {
        switch (group) {
          case "targets":
            currentDistance = 0;
            break;
          case "related":
            currentDistance = 1;
            break;
          case "extended":
            currentDistance = 2;
            break;
          default:
            if (group.startsWith("distance_")) {
              const d = parseInt(group.slice(9), 10);
              if (!isNaN(d)) {
                currentDistance = d;
              }
            }
            break;
        }
      }
      continue;
    }
    if (line.startsWith("# ")) {
      continue;
    }
    if (inEdges) {
      const edge = parseEdgeLine(line, symByID);
      p.edges.push(edge);
    } else {
      const { symbol, id } = parseSymbolLine(line, currentDistance);
      symbols.push(symbol);
      symByID.set(id, symbol);
    }
  }
  if (edgesDeclared && p.edges.length !== declaredEdges) {
    throw new Error(`count_mismatch: declared ${declaredEdges} edges, got ${p.edges.length}`);
  }
  p.symbols = symbols;
  return p;
}
function parseHeader(fields, p) {
  const parts = fields.split(/\s+/);
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx < 0)
      continue;
    const key = part.slice(0, eqIdx);
    const value = part.slice(eqIdx + 1);
    switch (key) {
      case "tool":
        p.tool = value;
        break;
      case "budget": {
        const v = parseInt(value, 10);
        if (isNaN(v))
          throw new Error(`gcf: invalid budget "${value}"`);
        p.tokenBudget = v;
        break;
      }
      case "tokens": {
        const v = parseInt(value, 10);
        if (isNaN(v))
          throw new Error(`gcf: invalid tokens "${value}"`);
        p.tokensUsed = v;
        break;
      }
      case "pack_root":
        p.packRoot = value;
        break;
      case "symbols":
        break;
    }
  }
}
function parseSymbolLine(line, distance) {
  if (!line.startsWith("@")) {
    throw new Error(`gcf: expected symbol line starting with @, got "${line}"`);
  }
  const parts = line.split(/\s+/);
  if (parts.length < 5) {
    throw new Error(`invalid_node_line: symbol line needs at least 5 fields, got ${parts.length} in "${line}"`);
  }
  const idStr = parts[0].slice(1);
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    throw new Error(`invalid_symbol_id: invalid symbol id "${idStr}"`);
  }
  let kind = parts[1];
  if (KIND_EXPAND[kind]) {
    kind = KIND_EXPAND[kind];
  }
  const qname = parts[2];
  const score = parseFloat(parts[3]);
  if (isNaN(score)) {
    throw new Error(`invalid_score: invalid score "${parts[3]}"`);
  }
  const provenance = parts[4];
  return {
    symbol: {
      qualifiedName: qname,
      kind,
      score,
      provenance,
      distance
    },
    id
  };
}
function parseEdgeLine(line, symByID) {
  const parts = line.split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`gcf: edge line needs at least 2 fields, got "${line}"`);
  }
  const ref = parts[0];
  const ltIdx = ref.indexOf("<");
  if (ltIdx < 0) {
    throw new Error(`invalid_edge_syntax: edge line missing '<' separator in "${ref}"`);
  }
  const targetIDStr = ref.slice(1, ltIdx);
  const sourceIDStr = ref.slice(ltIdx + 2);
  const targetID = parseInt(targetIDStr, 10);
  if (isNaN(targetID)) {
    throw new Error(`gcf: invalid target id "${targetIDStr}"`);
  }
  const sourceID = parseInt(sourceIDStr, 10);
  if (isNaN(sourceID)) {
    throw new Error(`gcf: invalid source id "${sourceIDStr}"`);
  }
  const targetSym = symByID.get(targetID);
  const sourceSym = symByID.get(sourceID);
  if (!targetSym || !sourceSym) {
    throw new Error(`unknown_edge_reference: edge references unknown symbol id(s): target=${targetID} source=${sourceID}`);
  }
  const edgeType = parts[1];
  const status = parts.length >= 3 ? parts[2] : void 0;
  return {
    source: sourceSym.qualifiedName,
    target: targetSym.qualifiedName,
    edgeType,
    status
  };
}

// node_modules/@blackwell-systems/gcf/dist/decode_generic.js
function checkDupMap(m, key) {
  if (m.has(key))
    throw new Error(`duplicate_key: ${key}`);
}
function decodeGeneric(input, opts) {
  setLargeIntMode(opts?.largeInt ?? "error");
  try {
    return decodeGenericImpl(input);
  } finally {
    setLargeIntMode("error");
  }
}
function decodeGenericImpl(input) {
  input = input.trimEnd();
  if (!input)
    throw new Error("missing_header: empty input");
  const lines = input.split("\n");
  const header = lines[0].replace(/\r$/, "");
  if (!header.startsWith("GCF "))
    throw new Error("missing_header: first line does not begin with GCF");
  const profile = parseHeaderProfile(header);
  if (profile === "graph") {
    const p = decode(input);
    return {
      tool: p.tool,
      tokenBudget: p.tokenBudget,
      tokensUsed: p.tokensUsed,
      packRoot: p.packRoot ?? "",
      symbols: p.symbols.map((s) => ({
        qualifiedName: s.qualifiedName,
        kind: s.kind,
        score: s.score,
        provenance: s.provenance,
        distance: s.distance
      })),
      edges: p.edges.map((e) => ({
        source: e.source,
        target: e.target,
        edgeType: e.edgeType,
        status: e.status ?? ""
      }))
    };
  }
  if (profile !== "generic")
    throw new Error(`unknown_profile: ${profile}`);
  const contentLines = [];
  let summaryLine = "";
  let deferredSectionCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, "");
    if (l === "")
      continue;
    for (let j = 0; j < l.length; j++) {
      if (l[j] === "	")
        throw new Error("tab_indentation: tabs in leading whitespace");
      if (l[j] !== " ")
        break;
    }
    const trimmed = l.trimStart();
    if (trimmed.startsWith("# "))
      continue;
    if (trimmed.startsWith("##! ")) {
      summaryLine = trimmed;
      continue;
    }
    if (trimmed.startsWith("## ") && (trimmed.includes("[?]") || trimmed.includes("[?:]")))
      deferredSectionCount++;
    contentLines.push(l);
  }
  if (summaryLine && deferredSectionCount > 0) {
    validateSummaryCounts(summaryLine, deferredSectionCount, contentLines);
  }
  if (contentLines.length === 0)
    return /* @__PURE__ */ new Map();
  const first = contentLines[0].trimStart();
  if (first.startsWith("=")) {
    if (contentLines.length > 1)
      throw new Error("trailing_characters: extra lines after root scalar");
    return parseScalar(first.slice(1), false);
  }
  if (first.startsWith("## [")) {
    const [arr, consumed] = parseArrayFromHeader(contentLines, 0, 0, first.slice(3));
    if (consumed < contentLines.length) {
      throw new Error("count_mismatch: declared count is fewer than the rows present");
    }
    return arr;
  }
  const result = /* @__PURE__ */ new Map();
  parseObjectBody(contentLines, 0, 0, result);
  return result;
}
function parseHeaderProfile(header) {
  const parts = header.split(/\s+/);
  if (parts.length < 2)
    throw new Error("missing_profile");
  const seen = /* @__PURE__ */ new Set();
  let profile = "";
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq < 0)
      throw new Error(`malformed_header_field: ${parts[i]}`);
    const key = parts[i].slice(0, eq);
    if (seen.has(key))
      throw new Error(`duplicate_header_field: ${key}`);
    seen.add(key);
    if (key === "profile")
      profile = parts[i].slice(eq + 1);
  }
  if (!profile)
    throw new Error("missing_profile");
  return profile;
}
function parseObjectBody(lines, start, depth, out) {
  const ind = "  ".repeat(depth);
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (depth > 0 && !line.startsWith(ind))
      break;
    const content = depth > 0 ? line.slice(ind.length) : line;
    if (content.length > 0 && content[0] === " ") {
      throw new Error("invalid_indent: indentation increases by more than one level");
    }
    if (content.startsWith("## ")) {
      const hdr = content.slice(3);
      const bi = findHeaderBracketStart(hdr);
      if (bi >= 0) {
        const name2 = parseKeyFromHeader(hdr.slice(0, bi));
        checkDupMap(out, name2);
        const [arr, consumed2] = parseArrayFromHeader(lines, i, depth, hdr.slice(bi));
        out.set(name2, arr);
        i += consumed2;
        continue;
      }
      const name = parseKeyFromHeader(hdr);
      checkDupMap(out, name);
      i++;
      const nested = /* @__PURE__ */ new Map();
      const consumed = parseObjectBody(lines, i, depth + 1, nested);
      out.set(name, nested);
      i += consumed;
      continue;
    }
    const eqIdx = findKeyValueSplit(content);
    if (eqIdx > 0) {
      const name = parseKeyFromHeader(content.slice(0, eqIdx));
      checkDupMap(out, name);
      out.set(name, parseScalar(content.slice(eqIdx + 1), false));
      i++;
      continue;
    }
    if (!content.startsWith("@") && !content.startsWith("##")) {
      const bracketIdx = arrayBracketStart(content);
      if (bracketIdx > 0) {
        const rest = content.slice(bracketIdx);
        const closeIdx = rest.indexOf("]");
        if (closeIdx >= 0) {
          const after = rest.slice(closeIdx + 1);
          if (after.startsWith(": ") || after === ":") {
            const name = parseKeyFromHeader(content.slice(0, bracketIdx));
            checkDupMap(out, name);
            const [arr] = parseArrayFromHeader(lines, i, depth, rest);
            out.set(name, arr);
            i++;
            continue;
          }
        }
      }
    }
    if (content.includes("|")) {
      throw new Error(`orphan_inline_attachment: ${content}`);
    }
    throw new Error(`invalid_line: unexpected content in object body: ${JSON.stringify(content)}`);
  }
  return i - start;
}
function findKeyValueSplit(s) {
  if (!s.length)
    return -1;
  if (s[0] === '"') {
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\") {
        i++;
        continue;
      }
      if (s[i] === '"')
        return i + 1 < s.length && s[i + 1] === "=" ? i + 1 : -1;
    }
    return -1;
  }
  const eqIdx = s.indexOf("=");
  if (eqIdx < 0)
    return -1;
  const bracketIdx = s.indexOf("[");
  if (bracketIdx >= 0 && bracketIdx < eqIdx)
    return -1;
  return eqIdx;
}
function arrayBracketStart(content) {
  if (content.charCodeAt(0) === 34) {
    let escaped = false;
    for (let i = 1; i < content.length; i++) {
      if (escaped) {
        escaped = false;
      } else if (content[i] === "\\") {
        escaped = true;
      } else if (content[i] === '"') {
        return content[i + 1] === "[" ? i + 1 : -1;
      }
    }
    return -1;
  }
  return content.indexOf("[");
}
function findHeaderBracketStart(hdr) {
  let i = 0;
  if (hdr[0] === '"') {
    i = 1;
    while (i < hdr.length) {
      if (hdr[i] === "\\") {
        i += 2;
        continue;
      }
      if (hdr[i] === '"') {
        i++;
        break;
      }
      i++;
    }
  }
  const bi = hdr.indexOf(" [", i);
  return bi;
}
function parseKeyFromHeader(s) {
  s = s.trim();
  if (s.length >= 2 && s[0] === '"')
    return parseQuotedString(s);
  return s;
}
function isUnsafePathKey(k) {
  return k === "__proto__" || k === "constructor" || k === "prototype";
}
function parseArrayFromHeader(lines, headerLine, depth, bracketPart) {
  const bp = bracketPart.trimStart();
  if (!bp.startsWith("["))
    throw new Error("invalid_count");
  const closeIdx = bp.indexOf("]");
  if (closeIdx < 0)
    throw new Error("invalid_count");
  let countStr = bp.slice(1, closeIdx);
  const afterBracket = bp.slice(closeIdx + 1);
  const keyed = countStr.endsWith(":");
  if (keyed) {
    countStr = countStr.slice(0, -1);
    if (!afterBracket.startsWith("{"))
      throw new Error("keyed_map: missing field declaration");
  }
  let count = -1;
  if (countStr !== "?")
    count = parseCount(countStr);
  if (keyed && count === 0) {
    throw new Error("keyed_map: zero count [0:] is invalid (an empty object uses Section 7.7)");
  }
  if (count === 0 && !afterBracket.startsWith("{") && !afterBracket.startsWith(":")) {
    return [[], 1];
  }
  if (afterBracket.startsWith(": ") || afterBracket === ":") {
    const valsStr = afterBracket.startsWith(": ") ? afterBracket.slice(2) : "";
    if (!valsStr) {
      if (count >= 0 && count !== 0)
        throw new Error(`count_mismatch: declared ${count}, got 0`);
      return [[], 1];
    }
    const vals = splitRespectingQuotes(valsStr, ",");
    if (count >= 0 && vals.length !== count)
      throw new Error(`count_mismatch: declared ${count}, got ${vals.length}`);
    return [vals.map((v) => parseScalar(v.trim(), false)), 1];
  }
  if (afterBracket.startsWith("{")) {
    const braceEnd = findClosingBrace2(afterBracket);
    if (braceEnd < 0)
      throw new Error("invalid field declaration");
    const fields = splitFieldDecl(afterBracket.slice(0, braceEnd + 1));
    const [rows, consumed2] = parseTabularBody(lines, headerLine + 1, depth, fields, count);
    if (count >= 0 && rows.length !== count)
      throw new Error(`count_mismatch: declared ${count}, got ${rows.length}`);
    if (keyed)
      return [keyedRowsToMap(rows, fields), consumed2 + 1];
    return [rows, consumed2 + 1];
  }
  const [items, consumed] = parseExpandedBody(lines, headerLine + 1, depth);
  if (count >= 0 && items.length !== count)
    throw new Error(`count_mismatch: declared ${count}, got ${items.length}`);
  return [items, consumed + 1];
}
function keyedRowsToMap(rows, fields) {
  if (fields.length < 2)
    throw new Error("keyed_map: header must declare at least two fields");
  const keyLabel = fields[0];
  const out = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const kv = row.has(keyLabel) ? row.get(keyLabel) : void 0;
    const ks = typeof kv === "string" ? kv : String(kv);
    if (out.has(ks))
      throw new Error(`keyed_map: duplicate member key ${ks}`);
    const value = /* @__PURE__ */ new Map();
    for (const [f, v] of row) {
      if (f === keyLabel)
        continue;
      value.set(f, v);
    }
    out.set(ks, value);
  }
  return out;
}
function findClosingBrace2(s) {
  let inQuote = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (s[i] === "\\" && inQuote) {
      escaped = true;
      continue;
    }
    if (s[i] === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (s[i] === "}" && !inQuote)
      return i;
  }
  return -1;
}
function unflattenPaths(pathColumns, flatValues, flatAbsent) {
  const groups = /* @__PURE__ */ new Map();
  const groupOrder = [];
  for (const [fieldName, paths] of pathColumns) {
    if (paths.length === 0)
      continue;
    if (paths.some(isUnsafePathKey))
      continue;
    const top = paths[0];
    if (!groups.has(top)) {
      groups.set(top, []);
      groupOrder.push(top);
    }
    groups.get(top).push(fieldName);
  }
  const result = /* @__PURE__ */ new Map();
  for (const top of groupOrder) {
    const fieldNames = groups.get(top);
    const allAbsent = fieldNames.every((f) => flatAbsent.has(f));
    const allNull = fieldNames.every((f) => {
      if (flatAbsent.has(f))
        return false;
      const val = flatValues.get(f);
      return val === null;
    });
    if (allAbsent)
      continue;
    if (allNull) {
      result.set(top, null);
      continue;
    }
    for (const fieldName of fieldNames) {
      if (flatAbsent.has(fieldName))
        continue;
      const paths = pathColumns.get(fieldName);
      const val = flatValues.has(fieldName) ? flatValues.get(fieldName) : null;
      let current = result;
      for (let k = 0; k < paths.length - 1; k++) {
        const segment = paths[k];
        const existing = current.get(segment);
        if (!current.has(segment) || !(existing instanceof Map)) {
          current.set(segment, /* @__PURE__ */ new Map());
        }
        current = current.get(segment);
      }
      current.set(paths[paths.length - 1], val);
    }
  }
  return result;
}
function parseTabularBody(lines, start, depth, fields, expectedCount) {
  const ind = "  ".repeat(depth);
  const rows = [];
  let i = start;
  const pathColumnMap = /* @__PURE__ */ new Map();
  for (const f of fields) {
    if (f.includes(">")) {
      const parts = f.split(">");
      if (parts.every((p) => p.length > 0)) {
        pathColumnMap.set(f, parts);
      }
    }
  }
  const inlineSchemas = /* @__PURE__ */ new Map();
  const sharedArraySchemas = /* @__PURE__ */ new Map();
  while (i < lines.length) {
    const line = lines[i];
    const content = depth > 0 ? line.startsWith(ind) ? line.slice(ind.length) : null : line;
    if (content === null)
      break;
    if (content.startsWith("## ") || content.startsWith("##!"))
      break;
    if (content.length > 0 && content[0] === " ") {
      const trimmed = content.trimStart();
      if (trimmed.startsWith("."))
        break;
      break;
    }
    let rowData = content;
    let rowHasID = false;
    if (rowData.startsWith("@")) {
      const sp = rowData.indexOf(" ");
      if (sp > 0) {
        const idStr = rowData.slice(1, sp);
        if (/^\d+$/.test(idStr)) {
          rowData = rowData.slice(sp + 1);
          rowHasID = true;
        }
      }
    }
    const vals = splitRespectingQuotes(rowData, "|");
    if (vals.length !== fields.length)
      throw new Error(`row_width_mismatch: expected ${fields.length}, got ${vals.length}`);
    const cellValues = /* @__PURE__ */ new Map();
    const traditionalAttFields = [];
    const inlineAttFields = [];
    const inlineAttOrder = [];
    const missingFields = /* @__PURE__ */ new Set();
    const flatValues = /* @__PURE__ */ new Map();
    const flatAbsent = /* @__PURE__ */ new Set();
    for (let j = 0; j < fields.length; j++) {
      const cellVal = vals[j];
      if (pathColumnMap.has(fields[j])) {
        const parsed2 = parseScalar(cellVal, true);
        if (parsed2 === MISSING) {
          flatAbsent.add(fields[j]);
        } else {
          flatValues.set(fields[j], parsed2);
        }
        continue;
      }
      if (cellVal.startsWith("^{") && cellVal.endsWith("}")) {
        const schemaStr = cellVal.slice(1);
        const ifs = splitFieldDecl(schemaStr);
        inlineSchemas.set(fields[j], ifs);
        inlineAttFields.push(fields[j]);
        inlineAttOrder.push(fields[j]);
        continue;
      }
      const parsed = parseScalar(cellVal, true);
      if (parsed === MISSING) {
        missingFields.add(fields[j]);
        continue;
      }
      if (parsed === ATTACHMENT) {
        if (inlineSchemas.has(fields[j])) {
          inlineAttFields.push(fields[j]);
          inlineAttOrder.push(fields[j]);
        } else {
          traditionalAttFields.push(fields[j]);
        }
        continue;
      }
      if (parsed && typeof parsed === "object" && parsed.__inlineSchema) {
        const ifs = splitFieldDecl(parsed.__inlineSchema);
        inlineSchemas.set(fields[j], ifs);
        inlineAttFields.push(fields[j]);
        inlineAttOrder.push(fields[j]);
        continue;
      }
      cellValues.set(fields[j], parsed);
    }
    i++;
    const allAttFields = [...traditionalAttFields, ...inlineAttFields];
    const attachmentValues = /* @__PURE__ */ new Map();
    const expectedAtt = new Set(allAttFields);
    if (rowHasID) {
      let inlineIdx = 0;
      while (i < lines.length) {
        const aLine = lines[i];
        let aContent = null;
        if (depth === 0 || aLine.startsWith(ind)) {
          aContent = depth > 0 ? aLine.slice(ind.length) : aLine;
        } else {
          break;
        }
        if (aContent === null)
          break;
        let attContent = aContent;
        if (!attContent.startsWith(".") && attContent.startsWith("  .")) {
          attContent = attContent.slice(2);
        }
        if (attContent.startsWith(".")) {
          const rest = attContent.slice(1);
          const [attName, afterName] = parseAttachmentName(rest);
          if (!expectedAtt.has(attName) && !attName.includes(">")) {
            throw new Error(`orphan_attachment: ${attName}`);
          }
          const ifs2 = inlineSchemas.get(attName);
          if (ifs2 && !afterName.trimStart().startsWith("{}") && !afterName.trimStart().startsWith("[")) {
            const data = afterName.trimStart();
            const inlineVals2 = splitRespectingQuotes(data, "|");
            if (inlineVals2.length !== ifs2.length)
              throw new Error(`inline_width_mismatch: ${attName} expected ${ifs2.length}, got ${inlineVals2.length}`);
            const obj2 = /* @__PURE__ */ new Map();
            for (let k = 0; k < ifs2.length; k++) {
              const p = parseScalar(inlineVals2[k], true);
              if (p !== MISSING)
                obj2.set(ifs2[k], p);
            }
            if (attachmentValues.has(attName))
              throw new Error(`duplicate_attachment: ${attName}`);
            attachmentValues.set(attName, obj2);
            i++;
            continue;
          }
          const [name, val, consumed, parsedFields] = parseAttachment(lines, i, rest, depth + 2, sharedArraySchemas);
          if (attachmentValues.has(name))
            throw new Error(`duplicate_attachment: ${name}`);
          if (rows.length === 0 && parsedFields) {
            sharedArraySchemas.set(name, parsedFields);
          }
          attachmentValues.set(name, val);
          i += consumed;
          continue;
        }
        let foundInline = false;
        let nextInlineField = "";
        while (inlineIdx < inlineAttOrder.length) {
          const candidate = inlineAttOrder[inlineIdx];
          if (!attachmentValues.has(candidate)) {
            nextInlineField = candidate;
            foundInline = true;
            break;
          }
          inlineIdx++;
        }
        if (!foundInline)
          break;
        const ifs = inlineSchemas.get(nextInlineField);
        const inlineVals = splitRespectingQuotes(aContent, "|");
        if (inlineVals.length !== ifs.length)
          throw new Error(`inline_width_mismatch: ${nextInlineField} expected ${ifs.length}, got ${inlineVals.length}`);
        const obj = /* @__PURE__ */ new Map();
        for (let k = 0; k < ifs.length; k++) {
          const p = parseScalar(inlineVals[k], true);
          if (p !== MISSING)
            obj.set(ifs[k], p);
        }
        attachmentValues.set(nextInlineField, obj);
        inlineIdx++;
        i++;
      }
      for (const f of allAttFields) {
        if (!attachmentValues.has(f))
          throw new Error(`missing_attachment: ${f}`);
      }
      if (i < lines.length) {
        let peekContent = null;
        if (depth === 0 || lines[i].startsWith(ind)) {
          peekContent = depth > 0 ? lines[i].slice(ind.length) : lines[i];
        }
        if (peekContent !== null) {
          let peekAtt = peekContent;
          if (!peekAtt.startsWith(".") && peekAtt.startsWith("  .")) {
            peekAtt = peekAtt.slice(2);
          }
          if (peekAtt.startsWith(".")) {
            const peekRest = peekAtt.slice(1);
            const [peekName] = parseAttachmentName(peekRest);
            if (attachmentValues.has(peekName)) {
              throw new Error(`duplicate_attachment: ${peekName}`);
            }
          }
        }
      }
    }
    const nested = pathColumnMap.size > 0 ? unflattenPaths(pathColumnMap, flatValues, flatAbsent) : /* @__PURE__ */ new Map();
    const emittedGroups = /* @__PURE__ */ new Set();
    const row = /* @__PURE__ */ new Map();
    for (const f of fields) {
      if (pathColumnMap.has(f)) {
        const top = pathColumnMap.get(f)[0];
        if (emittedGroups.has(top))
          continue;
        emittedGroups.add(top);
        if (nested.has(top))
          row.set(top, nested.get(top));
        continue;
      }
      if (missingFields.has(f))
        continue;
      if (cellValues.has(f)) {
        row.set(f, cellValues.get(f));
        continue;
      }
      if (attachmentValues.has(f)) {
        row.set(f, attachmentValues.get(f));
        continue;
      }
    }
    for (const [k, v] of attachmentValues) {
      if (!row.has(k))
        row.set(k, v);
    }
    rows.push(row);
    if (expectedCount >= 0 && rows.length >= expectedCount)
      break;
  }
  return [rows, i - start];
}
function parseAttachmentName(rest) {
  if (rest[0] === '"') {
    for (let j = 1; j < rest.length; j++) {
      if (rest[j] === "\\") {
        j++;
        continue;
      }
      if (rest[j] === '"') {
        const name = parseQuotedString(rest.slice(0, j + 1));
        return [name, rest.slice(j + 1)];
      }
    }
    return ["", rest];
  }
  const sp = rest.indexOf(" ");
  if (sp >= 0)
    return [rest.slice(0, sp), rest.slice(sp)];
  return [rest, ""];
}
function parseAttachment(lines, lineIdx, rest, depth, sharedSchemas) {
  const [name, afterNameRaw] = parseAttachmentName(rest);
  const afterName = afterNameRaw.trimStart();
  if (afterName.startsWith("{}")) {
    const nested = /* @__PURE__ */ new Map();
    const consumed = parseObjectBody(lines, lineIdx + 1, depth, nested);
    return [name, nested, consumed + 1, null];
  }
  if (afterName.startsWith("[")) {
    const closeBracket = afterName.indexOf("]");
    if (closeBracket < 0)
      throw new Error("invalid_count: missing ]");
    const afterClose = afterName.slice(closeBracket + 1);
    if (afterClose.startsWith("{")) {
      const isKeyed = afterName.slice(1, closeBracket).endsWith(":");
      const endBrace = findClosingBrace2(afterClose);
      let parsedFields = null;
      if (!isKeyed && endBrace >= 0) {
        try {
          parsedFields = splitFieldDecl(afterClose.slice(0, endBrace + 1));
        } catch {
        }
      }
      const [arr2, consumed2] = parseArrayFromHeader(lines, lineIdx, depth, afterName);
      return [name, arr2, consumed2, parsedFields];
    }
    const afterCloseForInline = afterName.slice(closeBracket + 1);
    if (afterCloseForInline.startsWith(": ") || afterCloseForInline === ":") {
      const [arr2, consumed2] = parseArrayFromHeader(lines, lineIdx, depth, afterName);
      return [name, arr2, consumed2, null];
    }
    if (sharedSchemas.has(name)) {
      const sf = sharedSchemas.get(name);
      const countStr = afterName.slice(1, closeBracket);
      let count = -1;
      if (countStr !== "?") {
        try {
          count = parseCount(countStr);
        } catch {
          count = -1;
        }
      }
      if (count === 0)
        return [name, [], 1, null];
      const nextIdx = lineIdx + 1;
      const ind = "  ".repeat(depth);
      let useShared = true;
      if (nextIdx < lines.length) {
        let nextContent = lines[nextIdx];
        if (depth > 0 && nextContent.startsWith(ind))
          nextContent = nextContent.slice(ind.length);
        if (nextContent.trimStart().startsWith("@"))
          useShared = false;
      }
      if (useShared) {
        const [rows, consumed2] = parseTabularBody(lines, lineIdx + 1, depth, sf, count);
        if (count >= 0 && rows.length !== count)
          throw new Error(`count_mismatch: declared ${count}, got ${rows.length}`);
        return [name, rows, consumed2 + 1, null];
      }
    }
    const [arr, consumed] = parseArrayFromHeader(lines, lineIdx, depth, afterName);
    return [name, arr, consumed, null];
  }
  if (afterName.startsWith("=")) {
    const valStr = afterName.slice(1);
    const parsed = parseScalar(valStr, true);
    if (parsed === MISSING)
      return [name, null, 1, null];
    return [name, parsed, 1, null];
  }
  throw new Error(`invalid attachment form: ${afterName}`);
}
function parseExpandedBody(lines, start, depth) {
  const ind = "  ".repeat(depth);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const content = depth > 0 ? line.startsWith(ind) ? line.slice(ind.length) : null : line;
    if (content === null)
      break;
    if (content.startsWith("## ") || content.startsWith("##!"))
      break;
    if (!content.startsWith("@"))
      break;
    const sp = content.indexOf(" ");
    if (sp < 0)
      break;
    const idStr = content.slice(1, sp);
    const id = parseInt(idStr, 10);
    if (!isNaN(id) && id !== items.length) {
      throw new Error(`invalid_item_id: expected @${items.length}, got @${idStr}`);
    }
    const marker = content.slice(sp + 1);
    if (marker.startsWith("=")) {
      items.push(parseScalar(marker.slice(1), false));
      i++;
      continue;
    }
    if (marker.startsWith("{}")) {
      const nested = /* @__PURE__ */ new Map();
      i++;
      const consumed = parseObjectBody(lines, i, depth + 1, nested);
      items.push(nested);
      i += consumed;
      continue;
    }
    if (marker.startsWith("[")) {
      const [arr, consumed] = parseArrayFromHeader(lines, i, depth + 1, marker);
      items.push(arr);
      i += consumed;
      continue;
    }
    break;
  }
  return [items, i - start];
}
function parseCount(s) {
  if (s === "0")
    return 0;
  if (!s.length || s[0] === "0")
    throw new Error(`invalid_count: ${s}`);
  const n = parseInt(s, 10);
  if (isNaN(n) || String(n) !== s)
    throw new Error(`invalid_count: ${s}`);
  return n;
}
function validateSummaryCounts(summaryLine, deferredCount, contentLines) {
  const parts = summaryLine.split(/\s+/);
  let countsStr = "";
  for (const p of parts) {
    if (p.startsWith("counts=")) {
      countsStr = p.slice(7);
      break;
    }
  }
  if (!countsStr)
    return;
  const countVals = countsStr.split(",");
  if (countVals.length !== deferredCount) {
    throw new Error(`count_mismatch: summary has ${countVals.length} count entries but ${deferredCount} deferred sections`);
  }
  const actualCounts = [];
  let inDeferred = false;
  let currentCount = 0;
  for (const l of contentLines) {
    const trimmed = l.trimStart();
    if (trimmed.startsWith("## ") && (trimmed.includes("[?]") || trimmed.includes("[?:]"))) {
      if (inDeferred)
        actualCounts.push(currentCount);
      inDeferred = true;
      currentCount = 0;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      if (inDeferred) {
        actualCounts.push(currentCount);
        inDeferred = false;
      }
      continue;
    }
    if (inDeferred && !trimmed.startsWith(" ") && !trimmed.startsWith(".")) {
      currentCount++;
    }
  }
  if (inDeferred)
    actualCounts.push(currentCount);
  for (let i = 0; i < countVals.length; i++) {
    const declared = parseInt(countVals[i], 10);
    if (isNaN(declared))
      throw new Error(`count_mismatch: invalid count value "${countVals[i]}"`);
    if (i < actualCounts.length && declared !== actualCounts[i]) {
      throw new Error(`count_mismatch: section ${i} declared ${declared} in summary, actual ${actualCounts[i]}`);
    }
  }
}

// node_modules/@blackwell-systems/gcf/dist/generic_delta_session.js
var ReanchorMode;
(function(ReanchorMode2) {
  ReanchorMode2[ReanchorMode2["FixedN"] = 0] = "FixedN";
  ReanchorMode2[ReanchorMode2["SizeGuard"] = 1] = "SizeGuard";
})(ReanchorMode || (ReanchorMode = {}));

// node_modules/@blackwell-systems/gcf/dist/stream_generic.js
var GenericStreamEncoder = class {
  constructor(writer) {
    __publicField(this, "writer");
    __publicField(this, "sections", []);
    __publicField(this, "current", null);
    __publicField(this, "err", null);
    this.writer = writer;
    this.writer.write("GCF profile=generic\n");
  }
  /** Start a tabular array section with deferred count [?]. */
  beginArray(name, fields) {
    if (this.err !== null) {
      return;
    }
    if (this.current !== null) {
      this.endArrayInternal();
    }
    for (const f of fields) {
      if (f.includes(">")) {
        this.err = new Error(`streaming field name ${JSON.stringify(f)} contains '>' (a flattened path is not representable in a streaming row)`);
        return;
      }
    }
    this.writer.write(`## ${formatKey(name)} [?]{${formatFieldDecl(fields)}}
`);
    this.current = { name, fields, count: 0 };
  }
  /** Start a keyed-map section with deferred count [?:] (SPEC 7.2a).
   *  keyLabel is the key column; valueFields are the value-object fields. Each
   *  writeRow value slice is [keyValue, ...valueFields]. */
  beginKeyedMap(name, keyLabel, valueFields) {
    if (this.err !== null) {
      return;
    }
    if (this.current !== null) {
      this.endArrayInternal();
    }
    for (const f of valueFields) {
      if (f.includes(">")) {
        this.err = new Error(`streaming field name ${JSON.stringify(f)} contains '>' (a flattened path is not representable in a streaming row)`);
        return;
      }
    }
    const fields = [keyLabel, ...valueFields];
    this.writer.write(`## ${formatKey(name)} [?:]{${formatFieldDecl(fields)}}
`);
    this.current = { name, fields, count: 0 };
  }
  /** Emit a single pipe-separated row immediately. */
  writeRow(values) {
    if (this.current === null) {
      return;
    }
    const parts = values.map(formatValue);
    this.writer.write(`${parts.join("|")}
`);
    this.current.count++;
  }
  /** Close the current array section and record its count. */
  endArray() {
    this.endArrayInternal();
  }
  /** Emit a key=value line immediately. */
  writeKV(key, value) {
    this.writer.write(`${key}=${formatValue(value)}
`);
  }
  /** Start a nested object section (## key). */
  writeSection(name) {
    if (this.current !== null) {
      this.endArrayInternal();
    }
    this.writer.write(`## ${name}
`);
  }
  /** Emit a primitive array inline: name[N]: val1,val2,val3 */
  writeInlineArray(name, values) {
    const parts = values.map(formatValue);
    this.writer.write(`${name}[${values.length}]: ${parts.join(",")}
`);
  }
  /** Emit the ##! summary trailer with final counts. Must be called after all data.
   *  Throws if a rejected field name (containing ">") was passed to beginArray. */
  close() {
    if (this.err !== null) {
      throw this.err;
    }
    if (this.current !== null) {
      this.endArrayInternal();
    }
    if (this.sections.length === 0) {
      return;
    }
    const counts = this.sections.map((s) => String(s.count));
    this.writer.write(`##! summary counts=${counts.join(",")}
`);
  }
  endArrayInternal() {
    if (this.current === null) {
      return;
    }
    this.sections.push({ name: this.current.name, count: this.current.count });
    this.current = null;
  }
};
function formatValue(v) {
  return formatScalar(v, 124);
}
function formatFieldDecl(fields) {
  return fields.map(formatKey).join(",");
}

// src/store/vectorCodec.ts
var zlib = __toESM(require("zlib"));
var VECTOR_CODEC = "f64le-deflate-base64";
function encodeVector(values) {
  if (values.length === 0) return "";
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setFloat64(i * 8, values[i], true);
  }
  return zlib.deflateSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).toString("base64");
}
function decodeVector2(cell) {
  if (cell === "") return new Float64Array(0);
  const bytes = zlib.inflateSync(Buffer.from(cell, "base64"));
  return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
}

// src/store/gcfIndex.ts
var INDEX_FORMAT_VERSION = 1;
var CURRENT_SCHEMA_VERSION = 2;
var FILES_FIELDS = ["vaultPath", "mtime", "chunkCount"];
var CHUNKS_FIELDS = ["id", "vaultPath", "page", "chunkIndex", "sourceType", "text", "embedding"];
var VAULT_PATH_COLUMN = 1;
function metaOf(embeddingModel, createdAt, updatedAt) {
  return {
    formatVersion: INDEX_FORMAT_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    embeddingModel,
    embeddingDimension: 0,
    vectorCodec: VECTOR_CODEC,
    createdAt,
    updatedAt
  };
}
function emptyMeta(embeddingModel) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return metaOf(embeddingModel, now, now);
}
function formatCell(value) {
  return formatScalar(value, 124);
}
function encodeFileRow(f) {
  return [f.vaultPath, f.mtime, f.chunkCount].map(formatCell).join("|");
}
var FILES_SECTION_HEADER = `## files [?]{${FILES_FIELDS.join(",")}}`;
var CHUNKS_SECTION_HEADER = `## chunks [?]{${CHUNKS_FIELDS.join(",")}}`;
function documentHeader(meta) {
  const lines = ["GCF profile=generic"];
  const kv = (key, value) => lines.push(`${key}=${formatCell(value)}`);
  kv("formatVersion", meta.formatVersion);
  kv("schemaVersion", meta.schemaVersion);
  kv("embeddingModel", meta.embeddingModel);
  kv("embeddingDimension", meta.embeddingDimension);
  kv("vectorCodec", meta.vectorCodec);
  kv("createdAt", meta.createdAt);
  kv("updatedAt", meta.updatedAt);
  return lines.join("\n") + "\n";
}
function encodeIndexDocument(meta, fileRecords, chunkRowTexts) {
  return documentHeader(meta) + `${FILES_SECTION_HEADER}
` + (fileRecords.length > 0 ? fileRecords.map(encodeFileRow).join("\n") + "\n" : "") + `${CHUNKS_SECTION_HEADER}
` + (chunkRowTexts.length > 0 ? chunkRowTexts.join("\n") + "\n" : "") + `##! summary counts=${fileRecords.length},${chunkRowTexts.length}
`;
}
function splitRow(line) {
  const parts = [];
  let current = "";
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escaped) {
      current += c;
      escaped = false;
      continue;
    }
    if (c === "\\" && inQuote) {
      current += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      inQuote = !inQuote;
      current += c;
      continue;
    }
    if (c === "|" && !inQuote) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}
function extractCell(line, index) {
  let inQuote = false;
  let escaped = false;
  let cell = 0;
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inQuote) {
      if (c === "\\") escaped = true;
      else if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      if (start < 0) start = i;
      continue;
    }
    if (c === "|") {
      if (cell === index) return line.slice(start === -1 ? i : start, i);
      cell++;
      start = -1;
      continue;
    }
    if (start < 0) start = i;
  }
  if (cell === index) return line.slice(start === -1 ? 0 : start);
  throw new Error(`invalid_index: row has no cell ${index}`);
}
function readMeta(metaMap) {
  const str = (k) => {
    const v = metaMap.get(k);
    if (typeof v !== "string") throw new Error(`invalid_index: missing or non-string metadata ${k}`);
    return v;
  };
  const num = (k) => {
    const v = metaMap.get(k);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`invalid_index: missing or non-numeric metadata ${k}`);
    return v;
  };
  return {
    formatVersion: num("formatVersion"),
    schemaVersion: num("schemaVersion"),
    embeddingModel: str("embeddingModel"),
    embeddingDimension: num("embeddingDimension"),
    vectorCodec: str("vectorCodec"),
    createdAt: str("createdAt"),
    updatedAt: str("updatedAt")
  };
}
function decodeIndexDocument(text) {
  const root = decodeGeneric(text);
  if (!(root instanceof Map)) throw new Error("invalid_index: document is not an object");
  const meta = readMeta(root);
  if (meta.formatVersion !== INDEX_FORMAT_VERSION) {
    throw new Error(`invalid_index: unsupported format version ${meta.formatVersion}`);
  }
  const filesRaw = root.get("files");
  if (!Array.isArray(filesRaw)) throw new Error("invalid_index: missing files section");
  const fileRecords = filesRaw.map((r) => {
    if (!(r instanceof Map)) throw new Error("invalid_index: file row is not an object");
    const f = {
      vaultPath: r.get("vaultPath"),
      mtime: r.get("mtime"),
      chunkCount: r.get("chunkCount")
    };
    if (typeof f.vaultPath !== "string" || typeof f.mtime !== "number" || typeof f.chunkCount !== "number") {
      throw new Error("invalid_index: file row has non-scalar cells");
    }
    return f;
  });
  const chunksRaw = root.get("chunks");
  if (!Array.isArray(chunksRaw)) throw new Error("invalid_index: missing chunks section");
  const chunkRecords = chunksRaw.map((r) => {
    if (!(r instanceof Map)) throw new Error("invalid_index: chunk row is not an object");
    const c = {
      id: r.get("id"),
      vaultPath: r.get("vaultPath"),
      page: r.get("page"),
      chunkIndex: r.get("chunkIndex"),
      sourceType: r.get("sourceType"),
      text: r.get("text"),
      embedding: r.get("embedding")
    };
    if (typeof c.id !== "string" || typeof c.vaultPath !== "string" || typeof c.page !== "number" || typeof c.chunkIndex !== "number" || typeof c.text !== "string" || typeof c.embedding !== "string") {
      throw new Error("invalid_index: chunk row has non-scalar cells");
    }
    if (c.sourceType !== "pdf" && c.sourceType !== "note") {
      throw new Error(`invalid_index: unknown sourceType ${JSON.stringify(c.sourceType)}`);
    }
    return { ...c, sourceType: c.sourceType, embedding: decodeVector2(c.embedding) };
  });
  const trailer = /(?:^|\n)##! summary counts=(\d+),(\d+)\n$/.exec(text);
  if (!trailer) throw new Error("invalid_index: missing summary trailer (truncated file?)");
  if (Number(trailer[1]) !== fileRecords.length || Number(trailer[2]) !== chunkRecords.length) {
    throw new Error("invalid_index: summary counts do not match index tables");
  }
  return { meta, fileRecords, chunkRecords };
}

// src/store/streamGcf.ts
var fs2 = __toESM(require("fs"));
var import_stream2 = require("stream");
var import_string_decoder = require("string_decoder");
function resolvePhysicalPath(base, vaultPath) {
  return base.endsWith("/") ? base + vaultPath : base + "/" + vaultPath;
}
function openLines(file) {
  const decoder = new import_string_decoder.StringDecoder("utf8");
  let pending = "";
  return fs2.createReadStream(file, { encoding: "utf8" }).pipe(
    new import_stream2.Transform({
      readableObjectMode: true,
      transform(chunk, _enc, cb) {
        const lines = (pending + decoder.write(chunk)).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) this.push(line);
        cb();
      },
      flush(cb) {
        const tail = pending + decoder.end();
        if (tail !== "") this.push(tail);
        cb();
      }
    })
  );
}
function writeDrained(w) {
  return new Promise((resolve, reject) => {
    w.once("drain", resolve);
    w.once("error", reject);
  });
}
function writeText(w, text) {
  if (w.write(text)) return Promise.resolve();
  return writeDrained(w);
}
async function appendRows(w, rows, counter) {
  try {
    for await (const line of rows) {
      counter.count++;
      if (!w.write(line + "\n")) {
        await writeDrained(w);
      }
    }
  } catch (err) {
    rows.destroy();
    throw err;
  }
}
function vaultPathOf(line) {
  try {
    const v = parseScalar(extractCell(line, VAULT_PATH_COLUMN), true);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
function committedChunkRows(file, skipVaultPaths) {
  let section = "none";
  return openLines(file).pipe(
    new import_stream2.Transform({
      objectMode: true,
      transform(line, _enc, cb) {
        if (line.startsWith("## ")) {
          section = line.startsWith("## chunks ") ? "chunks" : "other";
          cb();
          return;
        }
        if (line.startsWith("##!")) {
          cb();
          return;
        }
        if (section !== "chunks") {
          cb();
          return;
        }
        const p = vaultPathOf(line);
        if (p !== null && skipVaultPaths.has(p)) {
          cb();
        } else {
          cb(null, line);
        }
      }
    })
  );
}
function stagedChunkRows(file, upserted, rowStarts) {
  let section = "none";
  let rowIdx = 0;
  return openLines(file).pipe(
    new import_stream2.Transform({
      objectMode: true,
      transform(line, _enc, cb) {
        if (line.startsWith("## ")) {
          section = line.startsWith("## upserts ") ? "upserts" : "other";
          rowIdx = 0;
          cb();
          return;
        }
        if (line.startsWith("##!")) {
          cb();
          return;
        }
        if (section !== "upserts") {
          cb();
          return;
        }
        const idx = rowIdx++;
        const p = vaultPathOf(line);
        const start = p !== null ? rowStarts.get(p) : void 0;
        if (p !== null && upserted.has(p) && idx >= (start ?? 0)) cb(null, line);
        else cb();
      }
    })
  );
}
function parseFileRow(line) {
  const cells = splitRow(line);
  if (cells.length !== FILES_FIELDS.length) return null;
  const vaultPath = parseScalar(cells[0], true);
  const mtime = parseScalar(cells[1], true);
  const chunkCount = parseScalar(cells[2], true);
  if (typeof vaultPath !== "string" || vaultPath === "") return null;
  if (typeof mtime !== "number" || !Number.isFinite(mtime)) return null;
  if (typeof chunkCount !== "number" || !Number.isInteger(chunkCount) || chunkCount < 0) return null;
  return { vaultPath, mtime, chunkCount };
}
function validateChunkRow(line, embeddingDimension) {
  const cells = splitRow(line);
  if (cells.length !== CHUNKS_FIELDS.length) return false;
  const id = parseScalar(cells[0], true);
  const vaultPath = parseScalar(cells[1], true);
  const page = parseScalar(cells[2], true);
  const chunkIndex = parseScalar(cells[3], true);
  const sourceType = parseScalar(cells[4], true);
  const text = parseScalar(cells[5], true);
  if (typeof id !== "string" || id === "") return false;
  if (typeof vaultPath !== "string" || vaultPath === "") return false;
  if (typeof page !== "number" || typeof chunkIndex !== "number") return false;
  if (sourceType !== "pdf" && sourceType !== "note") return false;
  if (typeof text !== "string") return false;
  if (cells[6] === "") return embeddingDimension === 0;
  let decoded;
  try {
    decoded = decodeVector2(cells[6]);
  } catch {
    return false;
  }
  return decoded.length === embeddingDimension;
}
function expectedSectionFields(headerLine, fields) {
  const braceStart = headerLine.indexOf("{");
  const braceEnd = headerLine.indexOf("}", braceStart);
  if (braceStart < 0 || braceEnd < 0) return false;
  return headerLine.slice(braceStart + 1, braceEnd).split(",").join(",") === fields.join(",");
}
async function scanIndexDocumentStream(file) {
  const metaMap = /* @__PURE__ */ new Map();
  const fileRecords = [];
  let section = "meta";
  let chunkRowCount = 0;
  let complete = true;
  let summaryCounts = null;
  let sawSummary = false;
  let dimension = null;
  for await (const raw of openLines(file)) {
    const line = raw.replace(/\r$/, "");
    if (line === "") continue;
    if (line.startsWith("##! ")) {
      if (sawSummary) {
        complete = false;
        continue;
      }
      sawSummary = true;
      const m = line.match(/^##! summary counts=(\d+),(\d+)$/);
      if (!m) {
        complete = false;
      } else {
        summaryCounts = [Number(m[1]), Number(m[2])];
      }
      continue;
    }
    if (line.startsWith("## ")) {
      const name = line.slice(3, line.indexOf(" ["));
      if (dimension === null) {
        try {
          dimension = readMeta(metaMap).embeddingDimension;
        } catch {
          dimension = -1;
        }
      }
      if (name === "files") {
        if (section === "chunks") complete = false;
        if (!expectedSectionFields(line, FILES_FIELDS)) complete = false;
        section = "files";
      } else if (name === "chunks") {
        if (section === "chunks") complete = false;
        if (!expectedSectionFields(line, CHUNKS_FIELDS)) complete = false;
        section = "chunks";
      } else {
        complete = false;
        section = "other";
      }
      continue;
    }
    if (section === "meta") {
      const eq = line.indexOf("=");
      if (eq <= 0 || metaMap.has(line.slice(0, eq))) {
        complete = false;
        continue;
      }
      metaMap.set(line.slice(0, eq), parseScalar(line.slice(eq + 1), false));
      continue;
    }
    if (section === "files") {
      const record = parseFileRow(line);
      if (record === null) complete = false;
      else fileRecords.push(record);
      continue;
    }
    if (section === "chunks") {
      chunkRowCount++;
      if (dimension === -1 || !validateChunkRow(line, dimension ?? 0)) {
        complete = false;
      }
    }
  }
  let meta;
  try {
    meta = readMeta(metaMap);
  } catch {
    return { meta: { formatVersion: -1, schemaVersion: 0, embeddingModel: "", embeddingDimension: 0, vectorCodec: "", createdAt: "", updatedAt: "" }, fileRecords: [], chunkRowCount: 0, complete: false };
  }
  if (meta.formatVersion !== INDEX_FORMAT_VERSION) {
    return { meta, fileRecords, chunkRowCount, complete: false };
  }
  if (!sawSummary || summaryCounts === null || summaryCounts[0] !== fileRecords.length || summaryCounts[1] !== chunkRowCount) {
    return { meta, fileRecords, chunkRowCount, complete: false };
  }
  return { meta, fileRecords, chunkRowCount, complete };
}
async function readHeadScalars(file) {
  const metaMap = /* @__PURE__ */ new Map();
  try {
    for await (const raw of openLines(file)) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("##") || line === "") break;
      const eq = line.indexOf("=");
      if (eq <= 0) break;
      metaMap.set(line.slice(0, eq), parseScalar(line.slice(eq + 1), false));
    }
  } catch {
    return null;
  }
  return metaMap;
}
async function readTailTrailer(file) {
  let handle;
  try {
    handle = await fs2.promises.open(file, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size < 4) return null;
    const bytes = Math.min(size, 256);
    const buf = Buffer.allocUnsafe(bytes);
    await handle.read(buf, 0, bytes, size - bytes);
    const lines = buf.toString("utf8").split("\n").filter((l) => l !== "");
    const m = (lines[lines.length - 1] ?? "").match(
      /^##! summary counts=(\d+),(\d+)$/
    );
    return m ? { fileCount: Number(m[1]), chunkCount: Number(m[2]) } : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

// src/store/VectorStore.ts
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
var REPLACE_ERR_CODES = { EPERM: true, EACCES: true, EBUSY: true };
var VectorStore = class {
  constructor(pluginDir, app) {
    this.pluginDir = pluginDir;
    this.app = app;
    this.metaKnown = false;
    this.files = /* @__PURE__ */ new Map();
    this.chunks = null;
    this.loadedModel = null;
    this.loadedEpoch = -1;
    this.epoch = 0;
    this.session = null;
    this.loadPromise = null;
    this.indexDir = pluginDir + "/index";
    this.indexPath = this.indexDir + "/index.gcf";
    this.tmpPath = this.indexPath + ".tmp";
    this.asidePath = this.indexPath + ".swap";
    this.stagingPath = this.indexDir + "/.staging.gcf";
    this.meta = emptyMeta("");
  }
  // ── Query path (lazy load) ────────────────────────────────────────────────
  /**
   * Load the committed index (metadata, file table, chunks, vectors) on demand.
   * No-op when a current cache for `embeddingModel` exists. Throws
   * ProviderError DIMENSION_MISMATCH when the committed index was built with a
   * different model. Works while an indexing session is open (loads the last
   * published snapshot, which is never taken offline during indexing).
   */
  async ensureLoaded(embeddingModel) {
    if (this.chunks !== null && this.loadedEpoch === this.epoch && this.loadedModel === embeddingModel) return;
    const pending = this.loadPromise;
    if (pending) {
      await pending;
      if (this.chunks !== null && this.loadedEpoch === this.epoch && this.loadedModel === embeddingModel) return;
    }
    const p = this.doLoad(embeddingModel).finally(() => {
      this.loadPromise = null;
    });
    this.loadPromise = p;
    await p;
  }
  async doLoad(model, attempt = 0) {
    const adapter = this.app.vault.adapter;
    const startEpoch = this.epoch;
    const hadSession = this.session !== null;
    let committed = null;
    let unreadable = false;
    if (await adapter.exists(this.indexPath)) {
      try {
        committed = decodeIndexDocument(await adapter.read(this.indexPath));
      } catch {
        unreadable = true;
      }
    }
    if (this.epoch !== startEpoch || this.session !== null !== hadSession) {
      if (attempt < 3) return this.doLoad(model, attempt + 1);
    }
    if (unreadable) {
      this.metaKnown = true;
      if (!this.session) {
        this.meta = emptyMeta(model);
        this.files = /* @__PURE__ */ new Map();
      }
      this.chunks = [];
      this.loadedModel = model;
      this.loadedEpoch = this.epoch;
      return;
    }
    if (committed === null) {
      this.metaKnown = true;
      if (!this.session) {
        this.meta = emptyMeta(model);
        this.files = /* @__PURE__ */ new Map();
      }
      this.chunks = [];
      this.loadedModel = model;
      this.loadedEpoch = this.epoch;
      return;
    }
    const c = committed;
    const committedModel = c.meta.embeddingModel;
    if (committedModel !== "" && committedModel !== model) {
      throw new ProviderError(
        `Embedding model changed from '${committedModel}' to '${model}'. Re-index required.`,
        "DIMENSION_MISMATCH"
      );
    }
    this.metaKnown = true;
    if (!this.session) {
      this.meta = c.meta;
      this.meta.embeddingModel = committedModel === "" ? model : committedModel;
      this.files = new Map(c.fileRecords.map((f) => [f.vaultPath, f]));
    }
    this.chunks = c.chunkRecords;
    this.loadedModel = committedModel === "" ? model : committedModel;
    this.loadedEpoch = this.epoch;
  }
  /** Drop query chunk/vector memory. Lightweight stats/mtimes are retained. */
  unload() {
    this.chunks = null;
    this.loadedModel = null;
    this.loadedEpoch = -1;
    this.epoch++;
  }
  /** True when a current (post-publication) query cache is resident. */
  isLoaded() {
    return this.chunks !== null && this.loadedEpoch === this.epoch && this.loadedModel !== null;
  }
  query(queryEmbedding, topK) {
    if (!this.chunks || this.chunks.length === 0) return [];
    const q = Float64Array.from(queryEmbedding);
    const scored = this.chunks.map((chunk) => ({
      chunk,
      score: cosineSimilarity(q, chunk.embedding)
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((r) => ({
      score: r.score,
      chunk: {
        id: r.chunk.id,
        text: r.chunk.text,
        embedding: Array.from(r.chunk.embedding),
        sourceType: r.chunk.sourceType,
        vaultPath: r.chunk.vaultPath,
        page: r.chunk.page,
        chunkIndex: r.chunk.chunkIndex
      }
    }));
  }
  // ── Indexing session (disk-backed) ────────────────────────────────────────
  /**
   * Open a disk-backed indexing session for `embeddingModel`: unloads the query
   * vector cache, loads only metadata + file table from the committed GCF,
   * and opens the staging file. Vector data stays on disk for the whole run.
   * A model change resets
   * the file table so every file is re-embedded (the old-model vectors are
   * dropped at publication).
   */
  async prepareForIndexing(embeddingModel) {
    if (this.session) return;
    if (this.physicalBase() === null) {
      throw new Error("GCF index requires a desktop vault adapter (physical file paths)");
    }
    const adapter = this.app.vault.adapter;
    await adapter.mkdir(this.indexDir);
    await this.recoverCrashedSwap();
    await this.removeIfExists(this.tmpPath);
    await this.removeIfExists(this.stagingPath);
    let committedMeta = null;
    let committedFiles = [];
    let baseReadable = true;
    const hasGcf = await adapter.exists(this.indexPath);
    if (hasGcf) {
      const physical = resolvePhysicalPath(this.physicalBase(), this.indexPath);
      let scanned = null;
      try {
        scanned = await scanIndexDocumentStream(physical);
      } catch {
      }
      if (scanned !== null && scanned.complete && scanned.meta.formatVersion === INDEX_FORMAT_VERSION) {
        committedMeta = scanned.meta;
        committedFiles = scanned.fileRecords;
      } else {
        baseReadable = false;
      }
    }
    const baseMeta = committedMeta ?? emptyMeta(embeddingModel);
    const committedModel = committedMeta?.embeddingModel ?? "";
    const model = embeddingModel !== "" ? embeddingModel : committedModel;
    const replaceAll = model !== "" && committedModel !== "" && committedModel !== model;
    this.metaKnown = true;
    this.meta = { ...baseMeta, embeddingModel: model };
    this.files = new Map((replaceAll ? [] : committedFiles).map((f) => [f.vaultPath, f]));
    this.chunks = null;
    this.loadedModel = null;
    this.loadedEpoch = -1;
    const session = {
      model,
      replaceAll,
      baseReadable,
      upserted: /* @__PURE__ */ new Set(),
      removed: /* @__PURE__ */ new Set(),
      rowStart: /* @__PURE__ */ new Map(),
      stagedRowCount: 0,
      closing: false,
      encoder: void 0,
      // assigned below, before first write
      appendChain: Promise.resolve()
    };
    this.session = session;
    session.encoder = new GenericStreamEncoder({ write: (s) => this.stageAppend(s) });
    session.encoder.beginArray("upserts", [...CHUNKS_FIELDS]);
    await this.flushStaging();
  }
  /** Stage one file's chunk rows; the file counts as upserted only after the append is confirmed. */
  async upsertFile(vaultPath, mtime, chunks) {
    const session = this.session;
    if (!session || session.closing) {
      throw new Error("upsertFile requires an active indexing session (call prepareForIndexing first; none is open while a publication is in flight)");
    }
    session.rowStart.set(vaultPath, session.stagedRowCount);
    for (const c of chunks) {
      session.encoder.writeRow([c.id, c.vaultPath, c.page, c.chunkIndex, c.sourceType, c.text, encodeVector(c.embedding)]);
    }
    await this.flushStaging();
    session.upserted.add(vaultPath);
    session.removed.delete(vaultPath);
    session.stagedRowCount += chunks.length;
    if (this.meta.embeddingDimension === 0 && chunks.length > 0 && chunks[0].embedding.length > 0) {
      this.meta.embeddingDimension = chunks[0].embedding.length;
    }
    this.files.set(vaultPath, { vaultPath, mtime, chunkCount: chunks.length });
  }
  /**
   * Remove a file's entries. Works with the query DB unloaded (disk-backed).
   * No-op when the path has no entries. Self-contained when no session is
   * open (opens and publishes one); applies to the open session otherwise.
   */
  async removeFile(vaultPath) {
    const hadSession = this.session !== null;
    if (!hadSession) {
      await this.prepareForIndexing(this.meta.embeddingModel || "");
    }
    const session = this.session;
    if (this.files.has(vaultPath) || session.upserted.has(vaultPath)) {
      session.removed.add(vaultPath);
      session.upserted.delete(vaultPath);
      this.files.delete(vaultPath);
    }
    if (!hadSession) await this.finishIndexing();
  }
  stageAppend(s) {
    const session = this.session;
    if (!session) return;
    session.appendChain = session.appendChain.then(() => this.app.vault.adapter.append(this.stagingPath, s));
  }
  async flushStaging() {
    const session = this.session;
    if (!session) return;
    await session.appendChain;
  }
  /**
   * Install the tmp document as the committed index. A direct `fs.rename`
   * replaces an existing file in one step on POSIX, which is the atomic
   * publication this design needs. Obsidian's `adapter.rename` refuses to
   * overwrite on every platform ("Destination file already exists!"), and
   * on Windows `fs.rename` cannot replace an existing destination either —
   * in that case fall back to a two-step swap through the aside file:
   * commit aside -> new in place -> aside removed. If the swap itself fails,
   * the previous committed document is restored, so a failed publish never
   * leaves the index missing. A crash inside the swap window is repaired by
   * `recoverCrashedSwap` before the index is trusted again.
   */
  async publishSwap() {
    const physical = this.physicalBase();
    const tmp = resolvePhysicalPath(physical, this.tmpPath);
    const index = resolvePhysicalPath(physical, this.indexPath);
    try {
      await fs3.promises.rename(tmp, index);
      return;
    } catch (err) {
      const code = err.code;
      if (!code || !REPLACE_ERR_CODES[code]) throw err;
    }
    const aside = resolvePhysicalPath(physical, this.asidePath);
    try {
      await fs3.promises.rename(index, aside);
      await fs3.promises.rename(tmp, index);
      await fs3.promises.rm(aside, { force: true });
    } catch (swapErr) {
      try {
        if (fs3.existsSync(aside)) await fs3.promises.rename(aside, index);
      } catch {
      }
      throw swapErr;
    }
  }
  /**
   * Repair the state a crash inside the Windows two-step swap can leave:
   * committed missing + fully-written new document in tmp -> commit the new
   * one; committed missing + previous document set aside -> restore it;
   * committed present -> the aside is a stale duplicate, discard it.
   */
  async recoverCrashedSwap() {
    const physical = this.physicalBase();
    const index = resolvePhysicalPath(physical, this.indexPath);
    const tmp = resolvePhysicalPath(physical, this.tmpPath);
    const aside = resolvePhysicalPath(physical, this.asidePath);
    if (!fs3.existsSync(aside)) return;
    let hasIndex = false;
    let hasTmp = false;
    try {
      hasIndex = fs3.existsSync(index);
      hasTmp = fs3.existsSync(tmp);
    } catch {
      return;
    }
    if (hasIndex) {
      await fs3.promises.rm(aside, { force: true });
    } else if (hasTmp) {
      await fs3.promises.rename(tmp, index);
      await fs3.promises.rm(aside, { force: true });
    } else {
      await fs3.promises.rename(aside, index);
    }
  }
  /**
   * Publish the committed index + staged updates atomically (tmp write +
   * rename) and close the session. Unaffected chunk rows are STREAMED
   * verbatim from the committed document (line by line, pipe backpressure,
   * no vector decoding, no whole-document materialization); staged rows are
   * filtered to confirmed upserts. The session stays installed through the
   * async publication so a concurrent query cannot overwrite the staged file
   * table, and upserts are rejected while it runs. On any failure the
   * committed index, if it existed, is unchanged (staging is discarded; a
   * partial re-index simply re-runs on demand).
   */
  async finishIndexing() {
    const session = this.session;
    if (!session) return;
    const publishedMeta = { ...this.meta, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    const fileRecords = [...this.files.values()].sort(
      (a, b) => a.vaultPath < b.vaultPath ? -1 : a.vaultPath > b.vaultPath ? 1 : 0
    );
    const affected = /* @__PURE__ */ new Set([...session.upserted, ...session.removed]);
    const upserted = session.upserted;
    session.closing = true;
    const adapter = this.app.vault.adapter;
    const physical = this.physicalBase();
    try {
      session.encoder.close();
      await this.flushStaging();
      const hasCommitted = await adapter.exists(this.indexPath);
      const noOp = !session.replaceAll && session.upserted.size === 0 && session.removed.size === 0 && hasCommitted;
      if (!noOp) {
        const tmpFile = resolvePhysicalPath(physical, this.tmpPath);
        const out = fs3.createWriteStream(tmpFile, { encoding: "utf8" });
        const outFailed = new Promise((res) => {
          out.once("error", res);
        });
        const sources = [];
        const write = async () => {
          try {
            await writeText(out, documentHeader(publishedMeta));
            await writeText(out, `${FILES_SECTION_HEADER}
`);
            for (const f of fileRecords) {
              await writeText(out, encodeFileRow(f) + "\n");
            }
            await writeText(out, `${CHUNKS_SECTION_HEADER}
`);
            const retained = { count: 0 };
            if (hasCommitted && session.baseReadable && !session.replaceAll) {
              const committedFile = resolvePhysicalPath(physical, this.indexPath);
              const committedRows = committedChunkRows(committedFile, affected);
              sources.push(committedRows);
              await appendRows(out, committedRows, retained);
            }
            const staged = { count: 0 };
            if (await adapter.exists(this.stagingPath)) {
              const stagingFile = resolvePhysicalPath(physical, this.stagingPath);
              const stagedRows = stagedChunkRows(stagingFile, upserted, session.rowStart);
              sources.push(stagedRows);
              await appendRows(out, stagedRows, staged);
            }
            await writeText(out, `##! summary counts=${fileRecords.length},${retained.count + staged.count}
`);
            await new Promise((resolve, reject) => {
              out.once("error", reject);
              out.end(() => resolve());
            });
          } catch (err) {
            out.destroy();
            throw err;
          }
        };
        try {
          await Promise.race([write(), outFailed.then((e) => {
            throw e;
          })]);
        } catch (err) {
          for (const s of sources) s.destroy();
          out.destroy();
          throw err;
        }
        await this.publishSwap();
        this.epoch++;
        if (this.loadedEpoch !== this.epoch) {
          this.chunks = null;
          this.loadedModel = null;
          this.loadedEpoch = -1;
        }
      }
    } finally {
      this.session = null;
      await this.removeIfExists(this.stagingPath);
      await this.removeIfExists(this.tmpPath);
    }
  }
  /**
   * Persist current in-flight work. Indexing runs publish exactly once, in
   * `finishIndexing`; this is a no-op when no session is open (the committed
   * index is already current).
   */
  async save() {
    if (this.session) await this.finishIndexing();
  }
  /**
   * Delete the entire index: discards any open session's staged work and
   * atomically publishes an empty index document.
   */
  async clear(embeddingModel) {
    if (this.session) {
      this.session = null;
      await this.removeIfExists(this.stagingPath);
    }
    const adapter = this.app.vault.adapter;
    await adapter.mkdir(this.indexDir);
    const meta = emptyMeta(embeddingModel);
    await adapter.write(this.tmpPath, encodeIndexDocument(meta, [], []));
    await this.publishSwap();
    this.epoch++;
    this.meta = meta;
    this.metaKnown = true;
    this.files = /* @__PURE__ */ new Map();
    this.chunks = [];
    this.loadedModel = embeddingModel;
    this.loadedEpoch = this.epoch;
  }
  // ── Lightweight state (valid while the query DB is unloaded) ──────────────
  async exists() {
    return this.app.vault.adapter.exists(this.indexPath);
  }
  /**
   * Returns null when there is no readable GCF index.
   */
  async peekModel() {
    if (!this.metaKnown) {
      if (await this.app.vault.adapter.exists(this.indexPath)) {
        const base = this.physicalBase();
        if (base === null) return null;
        const head = await readHeadScalars(resolvePhysicalPath(base, this.indexPath));
        if (head) {
          try {
            const meta = readMeta(head);
            if (meta.formatVersion === INDEX_FORMAT_VERSION) {
              this.meta = meta;
              this.metaKnown = true;
            }
          } catch {
          }
        }
      }
    }
    return this.metaKnown && this.meta.embeddingModel !== "" ? this.meta.embeddingModel : null;
  }
  /**
   * Lightweight stats for display (settings status) without loading the
   * query DB: uses the in-memory file table when hydrated, otherwise reads
   * the document's header scalars + summary trailer (bounded reads).
   * Returns null when there is no committed GCF index on disk.
   */
  async peekStats() {
    if (!this.metaKnown) await this.peekModel();
    if (!this.metaKnown) return null;
    const stats = this.getStats();
    if (stats.fileCount > 0 || this.session !== null) return stats;
    const base = this.physicalBase();
    if (base === null) return stats;
    const trailer = await readTailTrailer(resolvePhysicalPath(base, this.indexPath));
    if (trailer === null) return stats;
    return { ...stats, fileCount: trailer.fileCount, chunkCount: trailer.chunkCount };
  }
  getFileMtime(vaultPath) {
    return this.files.get(vaultPath)?.mtime ?? null;
  }
  getIndexedPaths() {
    return [...this.files.keys()];
  }
  getStats() {
    let chunkCount = 0;
    if (this.chunks) {
      chunkCount = this.chunks.length;
    } else {
      for (const f of this.files.values()) chunkCount += f.chunkCount;
    }
    return {
      fileCount: this.files.size,
      chunkCount,
      embeddingModel: this.meta.embeddingModel,
      updatedAt: this.meta.updatedAt
    };
  }
  async removeIfExists(path2) {
    if (await this.app.vault.adapter.exists(path2)) {
      try {
        await this.app.vault.adapter.remove(path2);
      } catch {
      }
    }
  }
  /**
   * Physical base directory of the vault (desktop `FileSystemAdapter`
   * exposes `getBasePath`), or null on adapters without physical paths.
   * Row streaming requires a physical file; a null base means this adapter
   * cannot back the streaming index.
   */
  physicalBase() {
    const adapter = this.app.vault.adapter;
    return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
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
    /** Embed calls currently in flight — dispose must not tear the model down mid-inference. */
    this.inFlight = 0;
    /** Explicit "keep the model alive" scopes (e.g. a full index run holding the worker across files). */
    this.sessionCount = 0;
    /** Single-flight guard: concurrent dispose() calls share one provider.dispose() invocation. */
    this.disposePromise = null;
  }
  async embedBatch(texts, batchSize = 20) {
    if (texts.length === 0) return [];
    const allEmbeddings = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const result = await this.callEmbed(batch);
      allEmbeddings.push(...result.embeddings);
    }
    return allEmbeddings;
  }
  async embedQuery(text) {
    const result = await this.callEmbed([text]);
    return result.embeddings[0];
  }
  /**
   * Hold the model across a sequence of embedding calls so dispose() does
   * not tear it down between files. Pairs with endSession().
   */
  beginSession() {
    this.sessionCount++;
  }
  endSession() {
    if (this.sessionCount > 0) this.sessionCount--;
  }
  /**
   * Release the underlying model / inference process when idle.
   * No-op while an embed is in flight or a session is held; single-flight,
   * and safe to call repeatedly (a provider reloads lazily on next use).
   */
  dispose() {
    if (this.inFlight > 0 || this.sessionCount > 0) return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;
    const base = this.provider.dispose ? this.provider.dispose() : Promise.resolve();
    this.disposePromise = base.finally(() => {
      this.disposePromise = null;
    });
    return this.disposePromise;
  }
  /**
   * Unconditional release for plugin unload. Bypasses the in-flight/session
   * guards and invokes provider.dispose() immediately; the provider is
   * contractually cancel-safe and bounded (kills its worker rather than
   * waiting for a hung inference). Single-flights with dispose(), so a
   * normal release already running is reused, never doubled.
   */
  forceDispose() {
    if (this.disposePromise) return this.disposePromise;
    const base = this.provider.dispose ? this.provider.dispose() : Promise.resolve();
    this.disposePromise = base.finally(() => {
      this.disposePromise = null;
    });
    return this.disposePromise;
  }
  async callEmbed(texts) {
    this.inFlight++;
    try {
      return await this.provider.embed(texts);
    } finally {
      this.inFlight--;
    }
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
    await this.vectorStore.upsertFile(file.path, file.stat.mtime, allChunks);
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
      await this.vectorStore.upsertFile(file.path, file.stat.mtime, []);
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
    await this.vectorStore.upsertFile(file.path, file.stat.mtime, chunks);
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
    await this.vectorStore.prepareForIndexing(settings.embeddingModel);
    const files = this.getFilesToIndex(settings.indexScope);
    const result = { indexed: 0, skipped: 0, failed: 0, warnings: [] };
    try {
      const vaultPaths = new Set(this.app.vault.getFiles().map((f) => f.path));
      for (const p of this.vectorStore.getIndexedPaths()) {
        if (!vaultPaths.has(p)) {
          await this.vectorStore.removeFile(p);
        }
      }
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
      }
    } finally {
      await this.vectorStore.finishIndexing();
    }
    return result;
  }
  async indexCurrentFile(file, settings) {
    await this.vectorStore.prepareForIndexing(settings.embeddingModel);
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
    } finally {
      await this.vectorStore.finishIndexing();
    }
    return result;
  }
  async removeFile(vaultPath) {
    await this.vectorStore.removeFile(vaultPath);
  }
};

// src/indexScheduler.ts
var DEFAULT_QUIET_MS = 3 * 60 * 1e3;
var IndexScheduler = class {
  constructor(deps) {
    this.deps = deps;
    this.queue = Promise.resolve();
    this.activeChats = 0;
    this.lastActivity = 0;
    this.lastChatEnd = 0;
    /** Vault paths changed since the last pass (coalesced; deletions remove them). */
    this.pendingChanged = /* @__PURE__ */ new Set();
    /** Vault paths deleted/renamed away, processed after vault+chat quiet (never mid-chat). */
    this.pendingRemovals = /* @__PURE__ */ new Set();
    /** A full index pass was requested (manual click, startup, or preemption resume). */
    this.pendingPass = false;
    /** A full pass is enqueued but has not started yet (display-only; pendingPass covers quiet-gated waits). */
    this.passQueued = false;
    /** An explicit index clear (settings) is waiting for the quiet window. */
    this.pendingClear = false;
    /** Waiters for deferred clearIndex() calls — resolved when the clear runs. */
    this.clearWaiters = [];
    this.runController = null;
    this.indexing = false;
    this.runAbortedForChat = false;
    this.runCancelled = false;
    /** Runs not yet started stop at their start while a chat is active. */
    this.stopQueuedRuns = false;
    this.disposed = false;
    /** The most recent COMPLETED run (aborted runs are not recorded). */
    this.lastRun = null;
    this.quietMs = deps.quietMs ?? DEFAULT_QUIET_MS;
  }
  get isIndexing() {
    return this.indexing;
  }
  /** Queue snapshot for display (settings status). */
  getStatus() {
    return {
      indexing: this.indexing,
      queued: {
        changes: this.pendingChanged.size,
        removals: this.pendingRemovals.size,
        fullPass: this.pendingPass || this.passQueued,
        clear: this.pendingClear
      },
      lastRun: this.lastRun
    };
  }
  /**
   * Chat activity lease. Preempts any in-flight index pass at a file boundary
   * and waits for all DB-writing work already in flight or queued to settle,
   * so the index is stable and queryable when this resolves. Beginning and
   * ending a chat both count as "activity" for the quiet window.
   */
  async acquireChatLease() {
    this.activeChats++;
    this.noteActivity();
    this.stopQueuedRuns = true;
    if (this.indexing) {
      this.runAbortedForChat = true;
      this.runController?.abort();
    }
    await this.queue;
    let ended = false;
    return {
      end: () => {
        if (ended) return;
        ended = true;
        this.activeChats = Math.max(0, this.activeChats - 1);
        this.lastChatEnd = Date.now();
        if (this.runAbortedForChat) {
          this.runAbortedForChat = false;
          this.pendingPass = true;
        }
        this.noteActivity();
      }
    };
  }
  // ---- vault events -------------------------------------------------------
  onVaultModify(file) {
    if (this.disposed) return;
    if (file.extension !== "md" && file.extension !== "pdf") return;
    this.pendingRemovals.delete(file.path);
    this.pendingChanged.add(file.path);
    this.noteActivity();
  }
  onVaultDelete(file) {
    if (this.disposed) return;
    this.pendingChanged.delete(file.path);
    this.pendingRemovals.add(file.path);
    this.noteActivity();
  }
  onVaultRename(file, oldPath) {
    if (this.disposed) return;
    const f = file;
    this.pendingChanged.delete(oldPath);
    this.pendingRemovals.add(oldPath);
    if (f.extension === "md" || f.extension === "pdf") this.pendingChanged.add(f.path);
    this.noteActivity();
  }
  // ---- manual triggers ----------------------------------------------------
  /** Full index pass — command palette "Index all files" / settings Re-index. */
  requestManualIndex() {
    if (this.disposed) return;
    if (this.chatGated()) {
      this.deps.notify(
        "RAG: Chat is active or recent \u2014 indexing will start automatically once it settles.",
        5e3
      );
      this.pendingPass = true;
      return;
    }
    if (this.indexing) {
      this.deps.notify(
        "RAG: Indexing already in progress \u2014 another pass will run when it finishes.",
        3e3
      );
    }
    this.passQueued = true;
    this.enqueue(() => this.runPass("manual"));
  }
  /** Single file — command palette "Index current file". */
  indexFile(file) {
    if (this.disposed) return;
    if (file.extension !== "md" && file.extension !== "pdf") return;
    if (this.chatGated()) {
      this.deps.notify(
        "RAG: Chat is active or recent \u2014 the file will be indexed once it settles.",
        5e3
      );
      this.pendingPass = true;
      return;
    }
    if (this.indexing) {
      this.deps.notify(
        "RAG: Indexing in progress \u2014 the file will be indexed after the current pass.",
        3e3
      );
    }
    const path2 = file.path;
    void this.enqueue(() => this.runFile(path2)).catch(
      (err) => console.error("RAG: File index error:", err)
    );
  }
  /** User-initiated cancel of the current run. True if a run was in progress. */
  cancelIndex() {
    if (!this.indexing) return false;
    this.runCancelled = true;
    this.runController?.abort();
    return true;
  }
  /**
   * Clear the index (settings). Deferred while chat is active or recent —
   * clearing unloads the query DB, which must never overlap a chat. The
   * returned promise resolves once the clear has actually run.
   */
  clearIndex() {
    if (this.disposed) return Promise.resolve();
    if (this.chatGated()) {
      this.pendingClear = true;
      this.deps.notify(
        "RAG: Index clear queued \u2014 it will run once chat settles.",
        5e3
      );
      return new Promise((resolve) => this.clearWaiters.push(resolve));
    }
    return this.enqueue(
      () => this.deps.vectorStore.clear(this.deps.getSettings().embeddingModel)
    );
  }
  /** Startup hook: run a pass once the quiet window elapses (auto-index only). */
  markStartup() {
    if (this.disposed) return;
    if (!this.deps.getSettings().autoIndexOnStartup) return;
    this.pendingPass = true;
    this.noteActivity();
  }
  /** Plugin unload: stop pending work and force-release the embedder. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.quietTimer);
    this.quietTimer = void 0;
    this.pendingChanged.clear();
    this.pendingRemovals.clear();
    this.pendingPass = false;
    this.pendingClear = false;
    this.clearWaiters.splice(0).forEach((w) => w());
    this.runController?.abort();
    void this.deps.embeddingService.forceDispose().catch((err) => console.error("RAG: Embedder dispose failed:", err));
  }
  // ---- internals ----------------------------------------------------------
  noteActivity() {
    if (this.disposed) return;
    this.lastActivity = Date.now();
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = void 0;
      this.maybeRunPass();
    }, this.quietMs);
  }
  /**
   * Quiet window elapsed (or a run just finished): run any queued work.
   * Removals and an explicit clear are disk-backed; the index pass embeds.
   * Nothing here runs while a chat is active — the window includes chat activity.
   */
  maybeRunPass() {
    if (this.disposed || this.indexing || this.activeChats > 0) return;
    if (Date.now() - this.lastActivity < this.quietMs) return;
    if (this.pendingRemovals.size === 0 && !this.pendingPass && this.pendingChanged.size === 0 && !this.pendingClear) {
      return;
    }
    const manual = this.pendingPass;
    const hadChanged = this.pendingChanged.size > 0;
    this.pendingPass = false;
    this.pendingChanged.clear();
    if (this.pendingRemovals.size > 0) {
      void this.enqueue(() => this.runRemovals()).catch(
        (err) => console.error("RAG: Remove file error:", err)
      );
    }
    if (this.pendingClear) {
      this.pendingClear = false;
      const waiters = this.clearWaiters;
      this.clearWaiters = [];
      void this.enqueue(() => this.runClear(waiters)).catch(
        (err) => console.error("RAG: Index clear error:", err)
      );
    }
    if (manual || this.deps.getSettings().autoIndexOnStartup && hadChanged) {
      this.passQueued = true;
      this.enqueue(() => this.runPass(manual ? "manual" : "auto"));
    }
  }
  /** True while chat is active or within the recent-chat quiet window. */
  chatGated() {
    return this.activeChats > 0 || Date.now() - this.lastChatEnd < this.quietMs;
  }
  /** Append work to the single serial DB-write queue. */
  enqueue(work) {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async runPass(kind) {
    if (this.disposed) return;
    this.indexing = true;
    this.passQueued = false;
    this.runAbortedForChat = false;
    this.runCancelled = false;
    const controller = new AbortController();
    this.runController = controller;
    if (this.stopQueuedRuns && this.activeChats > 0) {
      this.runAbortedForChat = true;
      controller.abort();
    }
    const progress = this.deps.createProgressNotice();
    try {
      this.deps.embeddingService.beginSession();
      const result = await this.deps.indexManager.indexAll(
        this.deps.getSettings(),
        (current, total, filename) => {
          progress?.setMessage?.(`RAG: Indexing\u2026 ${current} / ${total}  \u2014  ${filename}`);
        },
        controller.signal
      );
      this.finishPass(kind, result, null);
    } catch (err) {
      this.finishPass(kind, null, err);
    } finally {
      this.afterRun();
      progress?.hide?.();
    }
  }
  async runFile(path2) {
    if (this.disposed) return;
    const file = this.deps.resolveFile(path2);
    if (!file) return;
    if (file.extension !== "md" && file.extension !== "pdf") return;
    this.indexing = true;
    this.runAbortedForChat = false;
    this.runCancelled = false;
    const controller = new AbortController();
    this.runController = controller;
    try {
      if (this.stopQueuedRuns && this.activeChats > 0) {
        this.runAbortedForChat = true;
        this.pendingChanged.add(path2);
        this.deps.notify("RAG: Chat in progress \u2014 the file index was deferred.", 3e3);
        return;
      }
      this.deps.embeddingService.beginSession();
      const result = await this.deps.indexManager.indexCurrentFile(
        file,
        this.deps.getSettings()
      );
      if (!this.runAbortedForChat && !this.runCancelled) {
        this.lastRun = {
          kind: "file",
          indexed: result.indexed,
          skipped: result.skipped,
          failed: result.failed,
          path: file.path,
          finishedAt: Date.now()
        };
      }
      if (!result.skipped && !this.runAbortedForChat && !this.runCancelled) {
        this.deps.notify(`RAG: Indexed ${file.name}.`, 3e3);
      }
    } catch (err) {
      if (this.runAbortedForChat || this.runCancelled) return;
      if (err instanceof ProviderError && err.code === "DIMENSION_MISMATCH") {
        this.deps.notify(
          'RAG: Embedding model changed \u2014 run "RAG: Index all files" to re-index.',
          1e4
        );
      } else if (this.isDesktopAdapterError(err)) {
        this.deps.notify(
          "RAG: Indexing requires a desktop vault (physical file paths). It is not supported on mobile.",
          1e4
        );
      } else {
        this.deps.notify(
          `RAG: Index failed \u2014 ${err.message ?? "unknown error"}`,
          8e3
        );
      }
    } finally {
      this.afterRun();
    }
  }
  /** Remove queued paths, one at a time (serialized). Re-created paths are skipped. */
  async runRemovals() {
    if (this.disposed) return;
    for (const path2 of [...this.pendingRemovals]) {
      if (this.pendingChanged.has(path2)) {
        this.pendingRemovals.delete(path2);
        continue;
      }
      await this.deps.indexManager.removeFile(path2);
      this.pendingRemovals.delete(path2);
    }
  }
  async runClear(waiters) {
    try {
      await this.deps.vectorStore.clear(this.deps.getSettings().embeddingModel);
    } finally {
      waiters.forEach((w) => w());
    }
  }
  finishPass(kind, result, err) {
    if (this.wasAborted(err)) {
      if (this.runCancelled) this.deps.notify("RAG: Indexing cancelled.", 4e3);
      return;
    }
    if (err !== null) {
      if (err instanceof ProviderError && err.code === "DIMENSION_MISMATCH") {
        this.deps.notify(
          'RAG: Embedding model changed \u2014 run "RAG: Index all files" to re-index.',
          1e4
        );
      } else if (this.isDesktopAdapterError(err)) {
        this.deps.notify(
          "RAG: Indexing requires a desktop vault (physical file paths). It is not supported on mobile.",
          1e4
        );
      } else {
        this.deps.notify(
          `RAG: Indexing failed \u2014 ${err.message ?? "unknown error"}`,
          8e3
        );
      }
      this.lastRun = {
        kind,
        indexed: 0,
        skipped: 0,
        failed: 0,
        error: err.message ?? "unknown error",
        finishedAt: Date.now()
      };
      return;
    }
    if (!result) return;
    this.lastRun = {
      kind,
      indexed: result.indexed,
      skipped: result.skipped,
      failed: result.failed,
      finishedAt: Date.now()
    };
    const parts = [`${result.indexed} indexed`];
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
    if (result.failed > 0) parts.push(`${result.failed} failed`);
    this.deps.notify(
      kind === "auto" ? `RAG: Auto index done \u2014 ${parts.join(", ")}.` : `RAG: Done \u2014 ${parts.join(", ")}.`,
      5e3
    );
    if (result.warnings.length > 0) {
      this.deps.notify(`RAG warnings: ${result.warnings.join("; ")}`, 8e3);
    }
  }
  wasAborted(err) {
    if (this.runAbortedForChat || this.runCancelled) return true;
    return err instanceof Error && err.message === "Indexing aborted";
  }
  /** The GCF index needs physical file paths — unavailable on non-desktop vaults. */
  isDesktopAdapterError(err) {
    return err instanceof Error && err.message.startsWith("GCF index requires a desktop vault adapter");
  }
  /** Common run teardown: DB is safe for queries again, release the model. */
  afterRun() {
    this.indexing = false;
    this.runController = null;
    this.deps.embeddingService.endSession();
    void this.deps.embeddingService.dispose().catch((err) => console.error("RAG: Embedder dispose failed:", err));
    this.maybeRunPass();
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
            return `CLI command failed: ${err.message} \u2014 check the CLI Command template in settings and use Test Connection to debug.`;
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
  constructor(provider, vectorStore, embeddingService, citationService, settings, acquireLease) {
    this.provider = provider;
    this.vectorStore = vectorStore;
    this.embeddingService = embeddingService;
    this.citationService = citationService;
    this.settings = settings;
    this.acquireLease = acquireLease;
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
    const lease = this.acquireLease ? await this.acquireLease() : null;
    try {
      return await this.askInner(question, signal, onToken);
    } finally {
      lease?.end();
    }
  }
  async askInner(question, signal, onToken) {
    try {
      await this.vectorStore.ensureLoaded(this.settings.embeddingModel);
    } catch (err) {
      if (err instanceof ProviderError && err.code === "DIMENSION_MISMATCH") {
        throw new ProviderError(
          'The index was built with a different embedding model. Run "RAG: Index all files" to rebuild the index, then try again.',
          "DIMENSION_MISMATCH"
        );
      }
      throw err;
    }
    if (!this.hasIndexedContent()) {
      return {
        displayContent: 'You have no indexed information.\n\nTo get started, open the command palette and run "RAG: Index all files" to index your PDFs and notes.',
        sources: []
      };
    }
    const queryEmbedding = await this.embeddingService.embedQuery(question);
    const results = this.vectorStore.query(queryEmbedding, this.settings.topK);
    await this.embeddingService.dispose();
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
var RagPlugin = class extends import_obsidian6.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
  }
  async onload() {
    await this.loadSettings();
    const embedder = createEmbedder(this.settings, (0, import_path4.join)(
      this.app.vault.adapter.getBasePath(),
      this.manifest.dir ?? ""
    ));
    const chatProvider = createChatProvider(this.settings);
    this.vectorStore = new VectorStore(this.manifest.dir ?? "", this.app);
    const chunkingService = new ChunkingService();
    this.embeddingService = new EmbeddingService(embedder);
    const citationService = new CitationService();
    this.indexManager = new IndexManager(
      this.app,
      chunkingService,
      this.embeddingService,
      this.vectorStore
    );
    this.indexScheduler = new IndexScheduler({
      indexManager: this.indexManager,
      embeddingService: this.embeddingService,
      vectorStore: this.vectorStore,
      getSettings: () => this.settings,
      resolveFile: (path2) => this.app.vault.getAbstractFileByPath(path2) ?? null,
      notify: (message, timeoutMs) => new import_obsidian6.Notice(message, timeoutMs),
      createProgressNotice: () => new import_obsidian6.Notice("RAG: Indexing\u2026 0 / ?", 0)
    });
    this.chatService = new ChatService(
      chatProvider,
      this.vectorStore,
      this.embeddingService,
      citationService,
      this.settings,
      () => this.indexScheduler.acquireChatLease()
    );
    this.registerView(
      VIEW_TYPE_RAG_CHAT,
      (leaf) => new RagView(leaf, this.chatService, this.settings)
    );
    this.addRibbonIcon(
      "message-square",
      "RAG: Open chat",
      () => this.openChatView()
    );
    this.vectorStore.exists().then(async (exists) => {
      if (!exists) {
        new import_obsidian6.Notice('RAG: No index found. Run "RAG: Index all files" to get started.', 8e3);
        return;
      }
      const indexedModel = await this.vectorStore.peekModel();
      if (indexedModel && indexedModel !== this.settings.embeddingModel) {
        new import_obsidian6.Notice('RAG: Embedding model changed \u2014 run "RAG: Index all files" to re-index.', 1e4);
      }
    }).catch((err) => console.error("RAG Plugin: Failed to check index:", err));
    this.addCommand({
      id: "rag-index-current-file",
      name: "Index current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (file.extension !== "pdf" && file.extension !== "md") return false;
        if (!checking) this.indexScheduler.indexFile(file);
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
        this.indexScheduler.cancelIndex();
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
        this.indexScheduler.onVaultModify(abstractFile);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (abstractFile) => {
        this.indexScheduler.onVaultDelete(abstractFile);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (abstractFile, oldPath) => {
        this.indexScheduler.onVaultRename(abstractFile, oldPath);
      })
    );
    if (this.settings.autoIndexOnStartup) {
      this.indexScheduler.markStartup();
    }
  }
  onunload() {
    this.indexScheduler.dispose();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_RAG_CHAT);
  }
  async indexAll() {
    this.indexScheduler.requestManualIndex();
  }
  async clearIndex() {
    return this.indexScheduler.clearIndex();
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
