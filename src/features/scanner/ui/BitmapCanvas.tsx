import { useEffect, useRef } from 'react';

/** Draws an ImageBitmap into a canvas of the given CSS width (height from its proportions). */
export function BitmapCanvas({ bitmap, width, opacity }: { bitmap: ImageBitmap; width: number | string; opacity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext('2d')?.drawImage(bitmap, 0, 0);
  }, [bitmap]);
  return <canvas ref={ref} style={{ width, height: 'auto', display: 'block', opacity }} />;
}
