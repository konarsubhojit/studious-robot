import { createCorrelationId, runStep, runStepSync } from '../src/logSteps';
import { logError, logInfo } from '../src/appLogger';

jest.mock('../src/appLogger', () => ({
  logInfo: jest.fn(),
  logError: jest.fn(),
}));

describe('logSteps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('runStep (async)', () => {
    test('logs start then success with durationMs and returns the result', async () => {
      const result = await runStep('[media] getUserMedia', async () => 'stream', {
        callId: 'abc123',
      });

      expect(result).toBe('stream');
      expect(logInfo).toHaveBeenCalledTimes(2);
      expect(logInfo).toHaveBeenNthCalledWith(1, '[media] getUserMedia start', {
        callId: 'abc123',
      });

      const [successMessage, successMeta] = logInfo.mock.calls[1];
      expect(successMessage).toBe('[media] getUserMedia success');
      expect(successMeta.callId).toBe('abc123');
      expect(typeof successMeta.durationMs).toBe('number');
      expect(logError).not.toHaveBeenCalled();
    });

    test('logs start then error with durationMs and rethrows', async () => {
      const failure = new Error('permission denied');
      failure.name = 'NotAllowedError';

      await expect(
        runStep('[media] getUserMedia', async () => {
          throw failure;
        }, { callId: 'abc123' }),
      ).rejects.toThrow('permission denied');

      expect(logInfo).toHaveBeenCalledTimes(1);
      expect(logInfo).toHaveBeenCalledWith('[media] getUserMedia start', { callId: 'abc123' });

      const [errorMessage, errorMeta] = logError.mock.calls[0];
      expect(errorMessage).toBe('[media] getUserMedia error');
      expect(typeof errorMeta.durationMs).toBe('number');
      expect(errorMeta.error).toEqual({ name: 'NotAllowedError', message: 'permission denied' });
    });
  });

  describe('runStepSync', () => {
    test('logs start then success and returns the result', () => {
      const result = runStepSync('[webrtc] addTrack', () => 42);

      expect(result).toBe(42);
      expect(logInfo).toHaveBeenCalledTimes(2);
      expect(logInfo.mock.calls[0][0]).toBe('[webrtc] addTrack start');
      expect(logInfo.mock.calls[1][0]).toBe('[webrtc] addTrack success');
      expect(typeof logInfo.mock.calls[1][1].durationMs).toBe('number');
    });

    test('logs start then error and rethrows', () => {
      const failure = new Error('boom');

      expect(() =>
        runStepSync('[webrtc] addTrack', () => {
          throw failure;
        }),
      ).toThrow('boom');

      expect(logInfo).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError.mock.calls[0][0]).toBe('[webrtc] addTrack error');
    });
  });

  describe('createCorrelationId', () => {
    test('returns an id of the requested length using the safe alphabet', () => {
      const id = createCorrelationId(8);
      expect(id).toHaveLength(8);
      expect(id).toMatch(/^[a-z0-9]+$/);
    });

    test('generates distinct ids', () => {
      expect(createCorrelationId()).not.toBe(createCorrelationId());
    });
  });
});
