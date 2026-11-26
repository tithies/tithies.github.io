import { Table, Text } from '@mantine/core';
import { SHOWN_METHODS } from '../models';
import type { Labels } from '../labels';
import { HEIGHT_BUCKETS, heightBucket, scorePhotos, type ScoredPhoto } from '../score';

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)} % (${n}/${d})` : '—');

/**
 * Scores of every method on the labelled photos (checked labels only). "Found" pairs labels that
 * have corners with the cards found by overlap: the detector alone; "extra" are shapes that are
 * no labelled card.
 */
export function ResultsTable({ photos, labels }: { photos: ScoredPhoto[]; labels: Labels }) {
  const labelled = photos.filter((p) => labels[p.file]?.cards.some((c) => c.checked || c.manual));
  if (!labelled.length) return <Text size="sm">None of the scanned photos has checked labels.</Text>;
  const buckets = [0, ...HEIGHT_BUCKETS].map(heightBucket);
  return (
    <Table striped fz="xs" verticalSpacing={4}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Method</Table.Th>
          <Table.Th>Cards labelled / detected</Table.Th>
          <Table.Th>Found (corners)</Table.Th>
          <Table.Th>Extra shapes</Table.Th>
          <Table.Th>Name, first try</Table.Th>
          <Table.Th>Name, top 5</Table.Th>
          <Table.Th>Print, first try</Table.Th>
          <Table.Th>Print, top 5</Table.Th>
          {buckets.map((b) => (
            <Table.Th key={b}>Name first try, {b} px</Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {SHOWN_METHODS.filter((m) => labelled.some((p) => p.detections.some((d) => d.byModel[m.id]))).map((m) => {
          const s = scorePhotos(labelled, labels, m.id);
          return (
            <Table.Tr key={m.id}>
              <Table.Td>{m.label}</Table.Td>
              <Table.Td>
                {s.labelled} / {s.detections}
              </Table.Td>
              <Table.Td>{pct(s.found, s.withQuad)}</Table.Td>
              <Table.Td>{s.unpaired}</Table.Td>
              <Table.Td>{pct(s.nameTop1, s.labelled)}</Table.Td>
              <Table.Td>{pct(s.nameTop5, s.labelled)}</Table.Td>
              <Table.Td>{pct(s.printTop1, s.withPrint)}</Table.Td>
              <Table.Td>{pct(s.printTop5, s.withPrint)}</Table.Td>
              {buckets.map((b) => (
                <Table.Td key={b}>{s.byHeight[b] ? pct(s.byHeight[b].nameTop1, s.byHeight[b].cards) : '—'}</Table.Td>
              ))}
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
