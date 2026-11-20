import { confidence, type MethodResult } from '@/features/scanner/pipeline';

const result = (score: number, margin: number): MethodResult => ({ turned: false, margin, candidates: [{ scryfallId: 'a', name: 'A', set: 's', setName: 'S', cn: '1', score }] }) as MethodResult;

describe('scanner confidence', () => {
  it('uses the limits of the model that named the cards', () => {
    // DINOv2 scores run high: 0.55 with a clear margin is sure.
    expect(confidence(result(0.55, 0.06), 'dino-pad-cls')).toBe('sure');
    // The tuned model: shapes spanning two cards score about 0.45-0.55, so that's only "review".
    expect(confidence(result(0.55, 0.06), 'dino-pad-cls', 'tuned')).toBe('review');
    expect(confidence(result(0.62, 0.1), 'dino-pad-cls', 'tuned')).toBe('sure');
    expect(confidence(result(0.62, 0.03), 'dino-pad-cls', 'tuned')).toBe('review');
    expect(confidence(result(0.35, 0.2), 'dino-pad-cls', 'tuned')).toBe('unknown');
    expect(confidence(undefined, 'dino-pad-cls', 'tuned')).toBe('unknown');
  });
});
