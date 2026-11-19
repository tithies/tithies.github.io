import { useMantineTheme } from '@mantine/core';
import { useEffect, useMemo, useRef } from 'react';
import { centroid } from '../geometry';
import { confidence, type ScannedPhoto } from '../pipeline';

const COLORS = { sure: 'green', review: 'orange', unknown: 'red' } as const;

export interface PhotoViewProps {
  photo: ScannedPhoto;
  /** Object URL of the original file (the <img> applies its orientation, like the scan did). */
  src: string;
  method: string;
  selected: number | null;
  onSelect: (n: number | null) => void;
  showEdges: boolean;
  showRejected: boolean;
}

/**
 * The photo with an SVG overlay in the scanned photo's pixels (viewBox), so outlines line up at
 * any display size: numbered card outlines coloured by confidence (dashed: inferred from the
 * binder grid), and, for debugging, the edge map and the shapes rejected.
 */
export function PhotoView({ photo, src, method, selected, onSelect, showEdges, showRejected }: PhotoViewProps) {
  const theme = useMantineTheme();
  const edgesRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = edgesRef.current;
    const e = photo.edges;
    if (!c || !e || !showEdges) return;
    c.width = e.width;
    c.height = e.height;
    c.getContext('2d')?.drawImage(e, 0, 0);
  }, [photo.edges, showEdges]);
  const stroke = Math.max(2, Math.round(Math.max(photo.width, photo.height) / 400));
  const font = Math.max(14, Math.round(Math.max(photo.width, photo.height) / 60));
  const cards = useMemo(() => photo.cards.map((c) => ({ c, conf: confidence(c.byMethod[method], method), center: centroid(c.quad) })), [photo, method]);

  return (
    <div style={{ position: 'relative', width: '100%', lineHeight: 0 }}>
      <img src={src} alt={photo.file} style={{ width: '100%', height: 'auto', display: 'block' }} />
      {showEdges && photo.edges && <canvas ref={edgesRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', mixBlendMode: 'screen', opacity: 0.8 }} />}
      <svg viewBox={`0 0 ${photo.width} ${photo.height}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} onClick={() => onSelect(null)}>
        {showRejected &&
          photo.rejected.map((r, i) => (
            <polygon key={`r${i}`} points={r.quad.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={r.reason === 'group' ? theme.colors.grape[4] : r.reason === 'duplicate' || r.reason === 'fragment' ? theme.colors.blue[4] : theme.colors.gray[5]} strokeWidth={stroke / 2} strokeDasharray={`${stroke * 2} ${stroke * 2}`}>
              <title>{r.reason}</title>
            </polygon>
          ))}
        {cards.map(({ c, conf, center }) => {
          const color = theme.colors[COLORS[conf]][5];
          const isSel = selected === c.n;
          const top = c.byMethod[method]?.candidates[0];
          return (
            <g
              key={c.n}
              style={{ cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(isSel ? null : c.n);
              }}
            >
              <polygon
                points={c.quad.map((p) => `${p.x},${p.y}`).join(' ')}
                fill={isSel ? `${color}33` : 'transparent'}
                stroke={color}
                strokeWidth={isSel ? stroke * 2 : stroke}
                strokeDasharray={c.source === 'grid' ? `${stroke * 4} ${stroke * 3}` : undefined}
              >
                <title>{`#${c.n} ${top ? `${top.name} (${top.set.toUpperCase()} #${top.cn}) ${top.score.toFixed(3)}` : 'no match'} · ${c.source} · ${Math.round(c.heightPx)} px`}</title>
              </polygon>
              <circle cx={center.x} cy={center.y} r={font * 0.9} fill={color} />
              <text x={center.x} y={center.y} fill="white" fontSize={font} fontWeight={700} textAnchor="middle" dominantBaseline="central">
                {c.n}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
