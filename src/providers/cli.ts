// CLI chat provider: runs an arbitrary user-configured command (OpenCode,
// OMP, or any one-shot LLM CLI) and extracts the answer from its stdout.
// The command line is a tokenized template — the plugin is deliberately
// tool-agnostic; presets are just starting points the user can extend with
// their own flags (model selection, agents, etc.).
//
// Uses Node.js child_process directly — no shell, so prompts containing
// metacharacters are passed as a single argv element, never interpreted.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require('child_process') as {
  spawn: (command: string, args: string[], options?: SpawnOptions) => ChildProcess;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('os');
import { ChatMessage, IChatProvider, PingResult, ProviderError } from './types';
import type { ChildProcess, SpawnOptions } from 'child_process';

export type CliPreset = 'opencode' | 'omp' | 'custom';

export const CLI_TOKENS = ['{prompt}', '{system}', '{question}', '{tmpdir}'] as const;

/**
 * Starting-point templates. The first token is the bare command name;
 * settings UI replaces it with the detected absolute path when available
 * (Dock-launched Obsidian on macOS has a minimal PATH).
 */
export const CLI_PRESETS: Record<CliPreset, string> = {
  opencode: 'opencode run --format json --dir {tmpdir} {prompt}',
  omp: 'omp -p --mode json --no-session {prompt}',
  custom: '{prompt}',
};

export const CLI_TEMPLATE_PLACEHOLDER = '{prompt}';

/** Extra directories to search for CLI binaries beyond process.env.PATH. */
const EXTRA_COMMAND_DIRS = [
  '~/.opencode/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '~/.local/bin',
  '~/.npm-global/bin',
];
/**
 * Build the command template for a preset, substituting the detected
 * absolute binary path where possible (Dock-launched Obsidian on macOS
 * has a minimal PATH). 'custom' starts as a bare {prompt} placeholder.
 */
export function applyCliPreset(preset: CliPreset): string {
  if (preset === 'custom') return CLI_TEMPLATE_PLACEHOLDER;
  const template = CLI_PRESETS[preset];
  const name = template.trim().split(/\s+/)[0];
  const resolved = resolveCliCommand(name);
  return resolved ? template.replace(name, resolved) : template;
}

export interface CliTemplateValues {
  /** Full conversation transcript (system + history + question), flattened. */
  prompt: string;
  /** System prompt content, if any. */
  system: string;
  /** The user's current question. */
  question: string;
  /** Fresh per-run working directory (isolates the agent from the vault). */
  tmpdir: string;
}

/**
 * Quote-aware word splitting of a command template.
 * Handles single and double quotes; unbalanced quotes are an error.
 */
export function tokenizeCliTemplate(template: string): string[] {
  const tokens: string[] = [];
  let current = '';
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
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  if (inSingle || inDouble) {
    throw new ProviderError(
      'Unbalanced quotes in CLI command template',
      'UNEXPECTED_RESPONSE'
    );
  }
  return tokens;
}

function expandToken(token: string, values: CliTemplateValues): string {
  if (token === '{prompt}') return values.prompt;
  if (token === '{system}') return values.system;
  if (token === '{question}') return values.question;
  if (token === '{tmpdir}') return values.tmpdir;
  let out = token;
  for (const t of CLI_TOKENS) {
    out = out.split(t).join(t === '{prompt}' ? values.prompt
      : t === '{system}' ? values.system
      : t === '{question}' ? values.question
      : values.tmpdir);
  }
  return out;
}

/**
 * Expand a template into an argv array.
 * A token standing alone becomes one argv element (values may contain
 * spaces); a token embedded in a quoted fragment is substituted inline.
 */
export function expandCliTemplate(template: string, values: CliTemplateValues): string[] {
  const trimmed = template.trim();
  if (!trimmed) {
    throw new ProviderError('CLI command template is empty', 'UNEXPECTED_RESPONSE');
  }
  if (!trimmed.includes('{prompt}') && !trimmed.includes('{system}') && !trimmed.includes('{question}')) {
    throw new ProviderError(
      'CLI command template must contain {prompt} (or {system} / {question})',
      'UNEXPECTED_RESPONSE'
    );
  }
  const tokens = tokenizeCliTemplate(trimmed);
  if (tokens.length === 0) {
    throw new ProviderError('CLI command template is empty', 'UNEXPECTED_RESPONSE');
  }
  return tokens.map(t => expandToken(t, values));
}

/**
 * Resolve a command name to an absolute path.
 * Absolute paths are validated as-is; bare names are searched in
 * process.env.PATH plus common install locations.
 */
export function resolveCliCommand(name: string): string | null {
  if (!name) return null;
  if (name.includes('/')) {
    return fs.existsSync(name) ? name : null;
  }
  const home = os.homedir();
  const dirs: string[] = [];
  const envPath = process.env.PATH ?? '';
  for (const dir of envPath.split(':')) {
    if (dir) dirs.push(dir);
  }
  for (const dir of EXTRA_COMMAND_DIRS) {
    dirs.push(dir.startsWith('~/') ? path.join(home, dir.slice(2)) : dir);
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Find a text-like field in parsed CLI output (bounded depth).
 * Handles flat shapes ({text}), OpenAI deltas ({delta:{content}}),
 * and agent event envelopes ({message:{content:[{text}]}}).
 * Returns null when nothing recognizable is found — callers fall back
 * to the raw stdout so the answer is never silently discarded.
 */
function findTextField(value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const found = findTextField(value[i]);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const field of ['text', 'content', 'answer', 'output']) {
      const candidate = obj[field];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    for (const field of ['content', 'message', 'messages', 'delta', 'data', 'result', 'response']) {
      const nested = obj[field];
      if (nested && typeof nested === 'object') {
        const found = findTextField(nested);
        if (found !== null) return found;
      }
    }
  }
  return null;
}

/**
 * True when an event envelope carries an assistant message.
 * Agent NDJSON streams echo the user prompt as a 'user' event; those
 * must not be mistaken for the answer.
 */
function isAssistantEvent(value: unknown): boolean {
  if (value == null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  const message = obj['message'];
  if (message && typeof message === 'object') {
    const role = (message as Record<string, unknown>)['role'];
    return role === 'assistant';
  }
  const messages = obj['messages'];
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1];
    return last !== null && typeof last === 'object'
      && (last as Record<string, unknown>)['role'] === 'assistant';
  }
  return obj['role'] === 'assistant';
}

/**
 * Extract the answer from CLI stdout.
 * 1. Whole output is a single JSON value → search for a text field.
 * 2. NDJSON (one JSON object per line, e.g. omp --mode json) → scan
 *    from the last line backwards, preferring assistant events so a
 *    user-prompt echo at the end of the stream is never returned.
 * 3. Otherwise the raw trimmed output is the answer.
 */
export function extractCliAnswer(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const found = findTextField(JSON.parse(trimmed));
      if (found !== null) return found;
    } catch { /* not clean JSON — fall through */ }
  }

  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isAssistantEvent(parsed)) continue;
    const found = findTextField(parsed);
    if (found !== null) return found;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      const found = findTextField(JSON.parse(line));
      if (found !== null) return found;
    } catch { /* keep scanning */ }
  }

  return trimmed;
}

/**
 * Pull a human-readable error out of CLI stdout.
 * Agent CLIs (omp --mode json) print their error stream as NDJSON on
 * stdout even when stderr is empty, so the raw dump is unreadable.
 * Prefers events with stopReason 'error' carrying an errorMessage
 * (omp), then falls back to a top-level errorMessage/error field.
 * Returns null when nothing recognizable is found.
 */
export function extractCliError(stdout: string): string | null {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const plain: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const top = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, unknown> : null;
    if (!top) continue;
    // Agent CLIs (omp) nest stopReason/errorMessage on the message object.
    const message = (top['message'] && typeof top['message'] === 'object')
      ? top['message'] as Record<string, unknown> : null;
    for (const scope of [top, message]) {
      if (!scope) continue;
      if (scope['stopReason'] === 'error') {
        const msg = typeof scope['errorMessage'] === 'string' ? scope['errorMessage'] : '';
        if (msg.trim()) return msg.trim().slice(0, 300);
      }
    }
    for (const scope of [top, message]) {
      if (!scope) continue;
      for (const field of ['errorMessage', 'error']) {
        const candidate = scope[field];
        if (typeof candidate === 'string' && candidate.trim()) plain.push(candidate.trim());
        else if (candidate && typeof candidate === 'object') {
          const nested = candidate as Record<string, unknown>;
          const nestedMsg = typeof nested['message'] === 'string' ? nested['message'] : '';
          if (nestedMsg.trim()) plain.push(nestedMsg.trim());
        }
      }
    }
  }
  return plain.length > 0 ? plain[plain.length - 1].slice(0, 300) : null;
}

/** Probe prompt used by ping() to verify a real round-trip. */
export const CLI_PROBE_PROMPT = 'Reply with exactly one word: PONG';

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  aborted: boolean;
  timedOut: boolean;
}

export class CliChatProvider implements IChatProvider {
  static readonly DEFAULT_TIMEOUT_MS = 180_000;
  static readonly PROBE_TIMEOUT_MS = 60_000;

  constructor(
    private template: string,
    private timeoutMs: number = CliChatProvider.DEFAULT_TIMEOUT_MS
  ) {}

  private async run(
    values: CliTemplateValues,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<RunResult> {
    if (signal.aborted) {
      throw new ProviderError('Stream aborted', 'STREAM_ABORTED');
    }

    const argv = expandCliTemplate(this.template, values);
    const resolved = resolveCliCommand(argv[0]);
    if (!resolved) {
      throw new ProviderError(
        `Command '${argv[0]}' not found. Enter the full path in the command template (e.g. /opt/homebrew/bin/omp).`,
        'CONNECTION_REFUSED'
      );
    }

    // Fresh temp cwd per run: the agent must answer from the prompt,
    // not start reading the user's vault.
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-rag-'));
    try {
      return await new Promise<RunResult>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;

        let child: ChildProcess;
        try {
          child = cp.spawn(resolved, argv.slice(1), {
            cwd: tmpdir,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          if (!child.stdout || !child.stderr) {
            child.kill('SIGTERM');
            reject(new ProviderError(
              `Could not capture output from '${resolved}'`,
              'CONNECTION_REFUSED'
            ));
            return;
          }
          child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        } catch (err) {
          reject(new ProviderError(
            `Failed to launch '${resolved}': ${(err as Error).message}`,
            'CONNECTION_REFUSED',
            err as Error
          ));
          return;
        }

        const timer = setTimeout(() => {
          if (!settled) {
            timedOut = true;
            child.kill('SIGTERM');
          }
        }, timeoutMs);

        const onAbort = () => child.kill('SIGTERM');
        signal.addEventListener('abort', onAbort, { once: true });

        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        };

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (signal.aborted) {
            reject(new ProviderError('Stream aborted', 'STREAM_ABORTED', err));
          } else {
            reject(new ProviderError(
              `Failed to launch '${resolved}': ${err.message}`,
              'CONNECTION_REFUSED',
              err
            ));
          }
        });

        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            stdout,
            stderr,
            code: code ?? -1,
            aborted: signal.aborted,
            timedOut,
          });
        });
      });
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  }

  async chat(
    messages: ChatMessage[],
    signal: AbortSignal,
    onToken?: (token: string) => void
  ): Promise<string> {
    // child_process.spawn rejects any argv element containing a NUL byte,
    // and the whole prompt becomes a single argument. Vault text (PDF text
    // extraction) can carry \u0000 for glyphs without a Unicode mapping; an
    // un-stripped NUL would crash the run while Test Connection (a fixed
    // probe string) still passes.
    const stripNul = (s: string) => s.replace(/\u0000/g, '');
    const system = stripNul(messages.find(m => m.role === 'system')?.content ?? '');
    const question = stripNul([...messages].reverse().find(m => m.role === 'user')?.content ?? '');
    const prompt = stripNul(messages.map(m => m.content).join('\n\n'));

    const result = await this.run({ prompt, system, question, tmpdir: '' }, signal, this.timeoutMs);

    if (result.aborted) {
      throw new ProviderError('Stream aborted', 'STREAM_ABORTED');
    }
    if (result.timedOut) {
      throw new ProviderError(
        `CLI command timed out after ${Math.round(this.timeoutMs / 1000)}s`,
        'REQUEST_TIMEOUT'
      );
    }
    if (result.code !== 0) {
      const detail = extractCliError(result.stdout) ?? (result.stderr || result.stdout).trim().slice(0, 300);
      throw new ProviderError(
        `CLI exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
        'UNEXPECTED_RESPONSE'
      );
    }

    const answer = extractCliAnswer(result.stdout);
    if (!answer) {
      throw new ProviderError('CLI returned an empty response', 'UNEXPECTED_RESPONSE');
    }
    onToken?.(answer);
    return answer;
  }

  /**
   * Round-trip probe: runs a minimal prompt through the real command and
   * reports the extracted answer in sampleResponse so the user can verify
   * the template's output is parseable.
   */
  async ping(): Promise<PingResult> {
    const start = Date.now();
    try {
      const answer = await this.chat(
        [{ role: 'user', content: CLI_PROBE_PROMPT }],
        new AbortController().signal,
        undefined
      );
      return { reachable: true, latencyMs: Date.now() - start, sampleResponse: answer };
    } catch (err) {
      return { reachable: false, latencyMs: 0, errorMessage: (err as Error).message };
    }
  }

  async listModels(): Promise<string[]> {
    // The CLI's configured model is the user's concern (template flags).
    return [];
  }
}
