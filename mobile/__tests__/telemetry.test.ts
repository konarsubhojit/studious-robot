import {
  clearCallTelemetry,
  getCallQoSSummary,
  trackCallStart,
  trackSelectedCandidatePair,
} from '../src/telemetry';

describe('call telemetry', () => {
  afterEach(() => {
    clearCallTelemetry('call-transport');
  });

  test('includes the selected candidate pair type in the QoS summary', () => {
    trackCallStart('call-transport', 'session-1');
    trackSelectedCandidatePair('call-transport', 'relay');

    expect(getCallQoSSummary('call-transport')).toEqual(
      expect.objectContaining({ selectedCandidatePairType: 'relay' }),
    );
  });
});
