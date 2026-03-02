import { App } from 'obsidian';
import { RagModal } from './RagModal';
import { QueryService } from '../rag/QueryService';
import { DEFAULT_SETTINGS, RagPluginSettings } from '../settings';
import { ProviderError } from '../providers/types';
import { RagAnswer } from '../rag/types';

function makeApp(): App {
  return {
    workspace: { openLinkText: jest.fn() },
    vault: {},
  } as any;
}

function makeAnswer(overrides: Partial<RagAnswer> = {}): RagAnswer {
  return {
    question: 'test?',
    answer: 'The answer is [1] and [2].',
    sources: [
      {
        chunk: {} as any,
        score: 0.9,
        obsidianLink: 'papers/doc.pdf#page=1',
        displayLabel: 'doc.pdf p.1',
      },
      {
        chunk: {} as any,
        score: 0.8,
        obsidianLink: 'notes/note.md',
        displayLabel: 'note.md',
      },
    ],
    confidence: 'high',
    durationMs: 100,
    ...overrides,
  };
}

describe('RagModal', () => {
  let mockQueryService: jest.Mocked<QueryService>;
  let mockApp: App;
  let modal: RagModal;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockQueryService = {
      query: jest.fn().mockResolvedValue(makeAnswer()),
    } as any;

    mockApp = makeApp();
    modal = new RagModal(mockApp, mockQueryService, { ...DEFAULT_SETTINGS });
    modal.onOpen();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('onOpen: createEl is called to build contentEl structure', () => {
    expect(modal.contentEl.createEl).toHaveBeenCalled();
    const calls = (modal.contentEl.createEl as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
  });

  test('submitQuery: calls queryService.query with the question and AbortSignal', async () => {
    await modal['submitQuery']('test question');

    expect(mockQueryService.query).toHaveBeenCalledTimes(1);
    const [question, signal] = mockQueryService.query.mock.calls[0];
    expect(question).toBe('test question');
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test('submitQuery: passes onToken callback when streamingEnabled is true', async () => {
    const streamingSettings: RagPluginSettings = { ...DEFAULT_SETTINGS, streamingEnabled: true };
    const streamingModal = new RagModal(mockApp, mockQueryService, streamingSettings);
    streamingModal.onOpen();

    await streamingModal['submitQuery']('streaming question');

    expect(mockQueryService.query).toHaveBeenCalledTimes(1);
    const args = mockQueryService.query.mock.calls[0];
    expect(args).toHaveLength(3);
    expect(typeof args[2]).toBe('function');
  });

  test('submitQuery: passes undefined onToken when streamingEnabled is false', async () => {
    const noStreamSettings: RagPluginSettings = { ...DEFAULT_SETTINGS, streamingEnabled: false };
    const noStreamModal = new RagModal(mockApp, mockQueryService, noStreamSettings);
    noStreamModal.onOpen();

    await noStreamModal['submitQuery']('no-stream question');

    expect(mockQueryService.query).toHaveBeenCalledTimes(1);
    const args = mockQueryService.query.mock.calls[0];
    expect(args[2]).toBeUndefined();
  });

  test('submitQuery: does nothing when question is empty string', async () => {
    await modal['submitQuery']('');

    expect(mockQueryService.query).not.toHaveBeenCalled();
  });

  test('getErrorMessage: CONNECTION_REFUSED → contains "Cannot connect"', () => {
    const err = new ProviderError('refused', 'CONNECTION_REFUSED');
    const msg = modal.getErrorMessage(err);
    expect(msg).toContain('Cannot connect');
  });

  test('getErrorMessage: MODEL_NOT_FOUND → contains "not found"', () => {
    const err = new ProviderError('model missing', 'MODEL_NOT_FOUND');
    const msg = modal.getErrorMessage(err);
    expect(msg).toContain('not found');
  });

  test('getErrorMessage: STREAM_ABORTED → returns empty string', () => {
    const err = new ProviderError('aborted', 'STREAM_ABORTED');
    const msg = modal.getErrorMessage(err);
    expect(msg).toBe('');
  });

  test('getErrorMessage: REQUEST_TIMEOUT → contains "timed out"', () => {
    const err = new ProviderError('timeout', 'REQUEST_TIMEOUT');
    const msg = modal.getErrorMessage(err);
    expect(msg).toContain('timed out');
  });

  test('getErrorMessage: unknown ProviderError code → returns "Provider error:"', () => {
    const err = new ProviderError('something else', 'UNEXPECTED_RESPONSE');
    const msg = modal.getErrorMessage(err);
    expect(msg).toContain('Provider error:');
  });

  test('getErrorMessage: "Indexing aborted" message → returns empty string', () => {
    const err = new Error('Indexing aborted');
    const msg = modal.getErrorMessage(err);
    expect(msg).toBe('');
  });

  test('getErrorMessage: non-ProviderError → returns "Unexpected error: ..."', () => {
    const err = new Error('something went wrong');
    const msg = modal.getErrorMessage(err);
    expect(msg).toBe('Unexpected error: something went wrong');
  });

  test('onClose: calls abort on the abortController if set', async () => {
    // Trigger a query to create an abortController
    const neverResolve = new Promise<RagAnswer>(() => {});
    mockQueryService.query.mockReturnValueOnce(neverResolve);

    modal['submitQuery']('pending question');

    const controller = modal['abortController'];
    expect(controller).not.toBeNull();

    const abortSpy = jest.spyOn(controller!, 'abort');
    modal.onClose();
    expect(abortSpy).toHaveBeenCalled();
  });

  test('onClose: calls contentEl.empty()', () => {
    modal.onClose();
    expect(modal.contentEl.empty).toHaveBeenCalled();
  });

  test('submitQuery: renders answer via renderAnswer after query resolves', async () => {
    await modal['submitQuery']('what is x?');

    // renderAnswer calls querySelector to find containers
    expect(modal.contentEl.querySelector).toHaveBeenCalled();
  });

  test('getErrorMessage: CONNECTION_REFUSED includes the baseUrl from settings', () => {
    const settings: RagPluginSettings = { ...DEFAULT_SETTINGS, baseUrl: 'http://localhost:9999' };
    const settingsModal = new RagModal(mockApp, mockQueryService, settings);
    const err = new ProviderError('refused', 'CONNECTION_REFUSED');
    const msg = settingsModal.getErrorMessage(err);
    expect(msg).toContain('http://localhost:9999');
  });

  test('getErrorMessage: MODEL_NOT_FOUND includes chatModel from settings', () => {
    const settings: RagPluginSettings = { ...DEFAULT_SETTINGS, chatModel: 'my-custom-model' };
    const settingsModal = new RagModal(mockApp, mockQueryService, settings);
    const err = new ProviderError('not found', 'MODEL_NOT_FOUND');
    const msg = settingsModal.getErrorMessage(err);
    expect(msg).toContain('my-custom-model');
  });
});
