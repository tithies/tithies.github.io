import { heightBucket, parseLabels, sameName, scorePhotos, type ScoredPhoto } from '@/features/scanner/score';

const c = (name: string, set = 'xxx', cn = '1') => ({ name, set, cn });

describe('scorePhotos', () => {
  const photos: ScoredPhoto[] = [
    {
      file: 'a.jpg',
      detections: [
        { heightPx: 500, byModel: { m: [c('Sol Ring', 'cmm', '410'), c('Sol Ring', 'c21', '263')] } },
        { heightPx: 200, byModel: { m: [c('Opt'), c('Counterspell', 'mh2', '267')] } },
        { heightPx: 300, byModel: { m: [c('Island')] } },
      ],
    },
    { file: 'unlabelled.jpg', detections: [{ heightPx: 100, byModel: { m: [c('Opt')] } }] },
  ];
  const labels = {
    'a.jpg': [{ name: 'Sol Ring', set: 'c21', cn: '263' }, { name: 'Counterspell', set: 'mh2', cn: '267' }, { name: 'Lightning Bolt' }],
  };

  it('pairs labels with detections, best rank first, and counts names and prints', () => {
    const s = scorePhotos(photos, labels, 'm');
    expect(s).toMatchObject({ labelled: 3, detections: 3, unpaired: 1, nameTop1: 1, nameTop5: 2, withPrint: 2, printTop1: 0, printTop5: 2 });
    expect(s.byHeight).toEqual({ '400–600': { cards: 1, nameTop1: 1 }, '150–250': { cards: 1, nameTop1: 0 } });
  });

  it('scores nothing for a method a detection lacks', () => {
    expect(scorePhotos(photos, labels, 'other')).toMatchObject({ labelled: 3, nameTop5: 0, unpaired: 3 });
  });
});

describe('labels', () => {
  it('matches double-faced names by their front face, case-insensitively', () => {
    expect(sameName('Delver of Secrets', 'Delver of Secrets // Insectile Aberration')).toBe(true);
    expect(sameName('sol ring', 'Sol Ring')).toBe(true);
    expect(sameName('Opt', 'Optimus')).toBe(false);
  });

  it('reads labels.json and rejects bad shapes', () => {
    expect(parseLabels('{"a.jpg":[{"name":"Opt","set":"dom","cn":60},{"name":"Island"}]}')).toEqual({ 'a.jpg': [{ name: 'Opt', set: 'dom', cn: '60' }, { name: 'Island' }] });
    expect(() => parseLabels('[]')).toThrow();
    expect(() => parseLabels('{"a.jpg":{}}')).toThrow();
    expect(() => parseLabels('{"a.jpg":[{"set":"dom"}]}')).toThrow();
  });

  it('buckets card heights', () => {
    expect([0, 149, 150, 399, 400, 599, 600, 2000].map(heightBucket)).toEqual(['0–150', '0–150', '150–250', '250–400', '400–600', '400–600', '≥600', '≥600']);
  });
});
