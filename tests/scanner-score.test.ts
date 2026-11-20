import type { Quad } from '@/features/scanner/geometry';
import { parseLabels, type Labels } from '@/features/scanner/labels';
import { heightBucket, scorePhotos, type ScoredPhoto } from '@/features/scanner/score';

const c = (name: string, set = 'xxx', cn = '1') => ({ name, set, cn });
const quad = (x: number, y: number, w = 100, h = 140): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

describe('scorePhotos, labels without corners', () => {
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
  const labels = parseLabels('{"a.jpg":[{"name":"Sol Ring","set":"c21","cn":"263"},{"name":"Counterspell","set":"mh2","cn":"267"},{"name":"Lightning Bolt"}]}');

  it('pairs labels with detections, best rank first, and counts names and prints', () => {
    const s = scorePhotos(photos, labels, 'm');
    expect(s).toMatchObject({ labelled: 3, detections: 3, unpaired: 1, withQuad: 0, found: 0, nameTop1: 1, nameTop5: 2, withPrint: 2, printTop1: 0, printTop5: 2 });
    expect(s.byHeight).toEqual({ '400–600': { cards: 1, nameTop1: 1 }, '150–250': { cards: 1, nameTop1: 0 } });
  });

  it('scores nothing for a method a detection lacks', () => {
    expect(scorePhotos(photos, labels, 'other')).toMatchObject({ labelled: 3, nameTop5: 0, unpaired: 3 });
  });

  it('pairs two Forests of different prints the right way round', () => {
    const forests: ScoredPhoto[] = [{ file: 'f.jpg', detections: [{ heightPx: 700, byModel: { m: [c('Forest', 'tdm', '285')] } }, { heightPx: 700, byModel: { m: [c('Forest', 'woe', '266')] } }] }];
    const l = parseLabels('{"f.jpg":[{"name":"Forest","set":"woe","cn":"266"},{"name":"Forest","set":"tdm","cn":"285"}]}');
    expect(scorePhotos(forests, l, 'm')).toMatchObject({ nameTop1: 2, printTop1: 2 });
  });
});

describe('scorePhotos, labels with corners', () => {
  const photo: ScoredPhoto = {
    file: 'a.jpg',
    scale: 0.5,
    detections: [
      { heightPx: 700, quad: quad(0, 0), byModel: { m: [c('Opt', 'dom', '60')] } },
      { heightPx: 700, quad: quad(300, 0), byModel: { m: [c('Shock')] } },
      { heightPx: 700, quad: quad(600, 0), byModel: { m: [c('Island')] } },
      { heightPx: 700, quad: quad(900, 0), byModel: { m: [c('Junk')] } },
    ],
  };
  const labels: Labels = {
    'a.jpg': {
      cards: [
        // Corners at full resolution: twice the scanned size.
        { name: 'Opt', set: 'dom', cn: '60', quad: quad(4, 0, 200, 280), checked: true },
        { name: 'Lightning Bolt', quad: quad(600, 0, 200, 280), checked: true },
        { name: 'Island', quad: quad(1200, 0, 200, 280), hidden: true, checked: true },
        { name: 'Missed', quad: quad(0, 1000, 200, 280), checked: true },
        { name: 'Hidden and missed', quad: quad(600, 1000, 200, 280), hidden: true, checked: true },
        // A draft nobody checked counts for nothing.
        { name: 'Junk', quad: quad(1800, 0, 200, 280) },
      ],
    },
  };

  it('pairs by overlap: found, named, extra, with hidden cards neither missed nor extra', () => {
    expect(scorePhotos([photo], labels, 'm')).toMatchObject({ labelled: 3, withQuad: 3, found: 2, detections: 4, unpaired: 1, nameTop1: 1, nameTop5: 1, withPrint: 1, printTop1: 1 });
  });

  it('pairs by name, not by corners, while the corners are unchecked', () => {
    const draft: Labels = { 'a.jpg': { cards: [{ name: 'Shock', quad: quad(0, 0, 200, 280), manual: true }] } };
    expect(scorePhotos([photo], draft, 'm')).toMatchObject({ labelled: 1, withQuad: 0, found: 0, nameTop1: 1 });
  });

  it('skips a photo with nothing checked', () => {
    expect(scorePhotos([photo], { 'a.jpg': { cards: [{ name: 'Opt', quad: quad(0, 0, 200, 280) }] } }, 'm')).toMatchObject({ labelled: 0, detections: 0 });
  });
});

describe('heights', () => {
  it('buckets card heights', () => {
    expect([0, 149, 150, 399, 400, 599, 600, 2000].map(heightBucket)).toEqual(['0–150', '0–150', '150–250', '250–400', '400–600', '400–600', '≥600', '≥600']);
  });
});
