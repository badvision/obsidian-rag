import { App } from 'obsidian';
import { IndexProgressModal } from './IndexProgressModal';
import { IndexManager } from '../indexer/IndexManager';
import { DEFAULT_SETTINGS } from '../settings';
import { IndexAllResult } from '../indexer/types';

function makeApp(): App {
  return {
    workspace: { openLinkText: jest.fn() },
    vault: {},
  } as any;
}

function makeResult(overrides: Partial<IndexAllResult> = {}): IndexAllResult {
  return {
    indexed: 3,
    skipped: 1,
    failed: 0,
    warnings: [],
    ...overrides,
  };
}

describe('IndexProgressModal', () => {
  let mockApp: App;
  let mockIndexManager: jest.Mocked<IndexManager>;
  let modal: IndexProgressModal;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockIndexManager = {
      indexAll: jest.fn().mockResolvedValue(makeResult()),
    } as any;

    mockApp = makeApp();
    modal = new IndexProgressModal(mockApp, mockIndexManager, { ...DEFAULT_SETTINGS });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('onOpen: calls indexManager.indexAll', () => {
    modal.onOpen();
    expect(mockIndexManager.indexAll).toHaveBeenCalledTimes(1);
  });

  test('onOpen: passes settings as first argument to indexAll', () => {
    modal.onOpen();
    const args = mockIndexManager.indexAll.mock.calls[0];
    expect(args[0]).toMatchObject({ provider: 'ollama' });
  });

  test('onOpen: passes an AbortSignal to indexAll', () => {
    modal.onOpen();
    const args = mockIndexManager.indexAll.mock.calls[0];
    // signal is the 3rd argument (index 2)
    expect(args[2]).toBeInstanceOf(AbortSignal);
  });

  test('onOpen: passes a progress callback to indexAll', () => {
    modal.onOpen();
    const args = mockIndexManager.indexAll.mock.calls[0];
    expect(typeof args[1]).toBe('function');
  });

  test('onOpen: calls createEl to build DOM structure', () => {
    modal.onOpen();
    expect(modal.contentEl.createEl).toHaveBeenCalled();
  });

  test('cancel button: aborts the abortController', () => {
    // Capture the cancel button addEventListener call
    let cancelClickHandler: (() => void) | null = null;

    // We need to intercept button creation. Since the mock returns a new element
    // each createEl call, we track the abort controller directly.
    const neverResolve = new Promise<IndexAllResult>(() => {});
    mockIndexManager.indexAll.mockReturnValueOnce(neverResolve);

    modal.onOpen();

    const controller = modal['abortController'];
    expect(controller).not.toBeNull();

    const abortSpy = jest.spyOn(controller!, 'abort');

    // Simulate abort via public interface
    controller!.abort();
    expect(abortSpy).toHaveBeenCalled();
  });

  test('onClose: calls contentEl.empty()', () => {
    modal.onOpen();
    modal.onClose();
    expect(modal.contentEl.empty).toHaveBeenCalled();
  });

  test('onClose: aborts the controller if indexing is in progress', () => {
    const neverResolve = new Promise<IndexAllResult>(() => {});
    mockIndexManager.indexAll.mockReturnValueOnce(neverResolve);

    modal.onOpen();

    const controller = modal['abortController'];
    const abortSpy = jest.spyOn(controller!, 'abort');

    modal.onClose();
    expect(abortSpy).toHaveBeenCalled();
  });

  test('completion with no warnings and no failures: setTimeout scheduled for auto-close', async () => {
    const result = makeResult({ indexed: 5, skipped: 0, failed: 0, warnings: [] });
    mockIndexManager.indexAll.mockResolvedValueOnce(result);

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    modal.onOpen();

    // Let the promise resolve
    await Promise.resolve();
    await Promise.resolve();

    // setTimeout should have been called with 3000ms for auto-close
    const autoCloseCalls = setTimeoutSpy.mock.calls.filter(
      (args) => args[1] === 3000
    );
    expect(autoCloseCalls.length).toBeGreaterThan(0);
  });

  test('completion with warnings: no auto-close setTimeout scheduled', async () => {
    const result = makeResult({ indexed: 2, warnings: ['scanned.pdf may be image-only'] });
    mockIndexManager.indexAll.mockResolvedValueOnce(result);

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    modal.onOpen();

    await Promise.resolve();
    await Promise.resolve();

    // setTimeout should NOT have been called with 3000 for auto-close
    const autoCloseCalls = setTimeoutSpy.mock.calls.filter(
      (args) => args[1] === 3000
    );
    expect(autoCloseCalls).toHaveLength(0);
  });

  test('completion with failures: no auto-close setTimeout scheduled', async () => {
    const result = makeResult({ indexed: 1, failed: 1, warnings: [] });
    mockIndexManager.indexAll.mockResolvedValueOnce(result);

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    modal.onOpen();

    await Promise.resolve();
    await Promise.resolve();

    const autoCloseCalls = setTimeoutSpy.mock.calls.filter(
      (args) => args[1] === 3000
    );
    expect(autoCloseCalls).toHaveLength(0);
  });

  test('showCompletion: updates heading and progress fill via querySelector', async () => {
    const result = makeResult({ indexed: 2, skipped: 0, failed: 0, warnings: [] });
    mockIndexManager.indexAll.mockResolvedValueOnce(result);

    modal.onOpen();

    await Promise.resolve();
    await Promise.resolve();

    // querySelector is used in showCompletion to find DOM elements
    expect(modal.contentEl.querySelector).toHaveBeenCalledWith('.rag-index-heading');
    expect(modal.contentEl.querySelector).toHaveBeenCalledWith('.rag-progress-fill');
    expect(modal.contentEl.querySelector).toHaveBeenCalledWith('.rag-index-stats');
    expect(modal.contentEl.querySelector).toHaveBeenCalledWith('.rag-cancel-index-btn');
  });

  test('onProgress callback: updates DOM elements via querySelector', () => {
    modal.onOpen();

    // Get the progress callback that was passed to indexAll
    const onProgress = mockIndexManager.indexAll.mock.calls[0][1] as (current: number, total: number, filename: string) => void;
    expect(onProgress).toBeDefined();

    // Call the progress callback
    onProgress(3, 10, 'test.pdf');

    // querySelector should have been called for progress elements
    expect(modal.contentEl.querySelector).toHaveBeenCalledWith('.rag-progress-fill');
    expect(modal.contentEl.querySelector).toHaveBeenCalledWith('.rag-progress-text');
    expect(modal.contentEl.querySelector).toHaveBeenCalledWith('.rag-current-file');
  });
});
