import { Table, Text } from '@mantine/core';
import { ALL_METHODS } from '../models';
import { HEIGHT_BUCKETS, heightBucket, scorePhotos, type Labels, type ScoredPhoto } from '../score';

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)} % (${n}/${d})` : '—');

/** Scores of every method on the labelled photos. */
export function ResultsTable({ photos, labels }: { photos: ScoredPhoto[]; labels: Labels }) {
  const labelled = photos.filter((p) => labels[p.file]);
  if (!labelled.length) return <Text size="sm">None of the scanned photos is in labels.json.</Text>;
  const buckets = [0, ...HEIGHT_BUCKETS].map(heightBucket);
  return (
    <Table striped fz="xs" verticalSpacing={4}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Method</Table.Th>
          <Table.Th>Cards labelled / detected / unpaired</Table.Th>
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
        {ALL_METHODS.map((m) => {
          const s = scorePhotos(labelled, labels, m.id);
          return (
            <Table.Tr key={m.id}>
              <Table.Td>{m.label}</Table.Td>
              <Table.Td>
                {s.labelled} / {s.detections} / {s.unpaired}
              </Table.Td>
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
