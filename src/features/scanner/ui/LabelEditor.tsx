import { Box } from '@mantine/core';
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { centroid, orderCorners, type Point, type Quad } from '../geometry';
import { svgPoints, type LabelCard } from '../labels';

export interface LabelEditorProps {
  /** Object URL of the photo (the <img> applies its orientation, like the labels' corners). */
  src: string;
  /** Full-resolution size. */
  width: number;
  height: number;
  cards: readonly LabelCard[];
  /** Outline colour of each card. */
  colorOf: (c: LabelCard) => string;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** A corner was dragged (released). */
  onQuadChange: (id: string, quad: Quad) => void;
  /** Clicking corners: 4 clicks give a card's outline. */
  adding: boolean;
  onAdded: (quad: Quad) => void;
  /** 1 = fit the width; 2, 4 = zoomed in (the box scrolls). */
  zoom: number;
  /** The number drawn on each card (default: its place in `cards`, from 1). */
  numberOf?: (c: LabelCard, i: number) => number;
  /** Cards still being worked on: a spinning ring around their number. */
  busy?: (c: LabelCard) => boolean;
}

/**
 * The photo with its labels drawn over it, in the photo's full-resolution pixels (viewBox).
 * The selected card shows its 4 corners as handles to drag; the card's own top-left corner is
 * the filled one. In "adding" mode, clicks place 4 corners (any order).
 */
export function LabelEditor({ src, width, height, cards, colorOf, selected, onSelect, onQuadChange, adding, onAdded, zoom, numberOf = (_, i) => i + 1, busy }: LabelEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ id: string; corner: number; quad: Quad } | null>(null);
  const [clicks, setClicks] = useState<Point[]>([]);
  // The corners clicked so far, also in a ref: quick clicks must not read a stale list.
  const clicksRef = useRef<Point[]>([]);
  const stroke = Math.max(2, Math.round(Math.max(width, height) / 500));
  const font = Math.max(14, Math.round(Math.max(width, height) / 70));
  const handle = stroke * 4;

  const toPhoto = (e: { clientX: number; clientY: number }): Point => {
    const svg = svgRef.current!;
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: Math.min(width, Math.max(0, p.x)), y: Math.min(height, Math.max(0, p.y)) };
  };

  const startDrag = (e: PointerEvent, id: string, corner: number, quad: Quad) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ id, corner, quad });
  };
  const moveDrag = (e: PointerEvent) => {
    if (!drag) return;
    const p = toPhoto(e);
    const quad = drag.quad.map((q, i) => (i === drag.corner ? p : q)) as Quad;
    setDrag({ ...drag, quad });
  };
  const endDrag = () => {
    if (!drag) return;
    onQuadChange(drag.id, drag.quad);
    setDrag(null);
  };

  const clickPhoto = (e: MouseEvent) => {
    if (!adding) {
      onSelect(null);
      return;
    }
    const pts = [...clicksRef.current, toPhoto(e)];
    clicksRef.current = pts.length < 4 ? pts : [];
    setClicks(clicksRef.current);
    if (pts.length === 4) onAdded(orderCorners(pts));
  };
  // Leaving the adding mode drops the corners clicked so far.
  useEffect(() => {
    if (adding) return;
    clicksRef.current = [];
    setClicks([]);
  }, [adding]);

  return (
    <Box style={{ overflow: 'auto', maxHeight: zoom > 1 ? '80vh' : undefined, border: '1px solid var(--mantine-color-default-border)' }}>
      <div style={{ position: 'relative', width: `${zoom * 100}%`, lineHeight: 0 }}>
        <img src={src} alt="" style={{ width: '100%', height: 'auto', display: 'block', userSelect: 'none' }} draggable={false} />
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: adding ? 'crosshair' : 'default', touchAction: 'none' }}
          onClick={clickPhoto}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        >
          {cards.map((c, i) => {
            if (!c.quad) return null;
            const quad = drag && drag.id === c.id ? drag.quad : c.quad;
            const color = colorOf(c);
            const isSel = selected === c.id;
            const center = centroid(quad);
            return (
              <g key={c.id}>
                <polygon
                  points={svgPoints(quad)}
                  fill={isSel ? `${color}33` : 'transparent'}
                  stroke={color}
                  strokeWidth={isSel ? stroke * 2 : stroke}
                  strokeDasharray={c.hidden ? `${stroke * 4} ${stroke * 3}` : undefined}
                  style={{ cursor: adding ? 'crosshair' : 'pointer' }}
                  onClick={(e) => {
                    if (adding) return;
                    e.stopPropagation();
                    onSelect(isSel ? null : c.id!);
                  }}
                >
                  <title>{`#${numberOf(c, i)} ${c.name}${c.set ? ` (${c.set.toUpperCase()} #${c.cn})` : ''}`}</title>
                </polygon>
                <circle cx={center.x} cy={center.y} r={font * 0.9} fill={color} pointerEvents="none" />
                {busy?.(c) && (
                  <circle cx={center.x} cy={center.y} r={font * 1.3} fill="none" stroke={color} strokeWidth={stroke * 1.5} strokeLinecap="round" strokeDasharray={`${font * 2} ${font * 6.2}`} pointerEvents="none">
                    <animateTransform attributeName="transform" type="rotate" from={`0 ${center.x} ${center.y}`} to={`360 ${center.x} ${center.y}`} dur="1s" repeatCount="indefinite" />
                  </circle>
                )}
                <text x={center.x} y={center.y} fill="white" fontSize={font} fontWeight={700} textAnchor="middle" dominantBaseline="central" pointerEvents="none">
                  {numberOf(c, i)}
                </text>
                {isSel &&
                  !adding &&
                  quad.map((p, k) => (
                    <circle
                      key={k}
                      cx={p.x}
                      cy={p.y}
                      r={handle}
                      fill={k === 0 ? color : 'white'}
                      stroke={color}
                      strokeWidth={stroke}
                      style={{ cursor: 'move' }}
                      onPointerDown={(e) => startDrag(e, c.id!, k, quad)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ))}
              </g>
            );
          })}
          {adding && clicks.length > 0 && (
            <>
              <polyline points={svgPoints(clicks)} fill="none" stroke="magenta" strokeWidth={stroke} pointerEvents="none" />
              {clicks.map((p, k) => (
                <circle key={k} cx={p.x} cy={p.y} r={handle} fill="magenta" pointerEvents="none" />
              ))}
            </>
          )}
        </svg>
      </div>
    </Box>
  );
}
