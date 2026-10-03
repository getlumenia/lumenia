/**
 * A QR code of the link, drawn as SVG rectangles (no canvas, no image, nothing leaves the popup).
 *
 * Horizontal runs of dark modules are merged into one rectangle, which keeps the element count to
 * a few hundred for a link this long. The quiet zone is part of the matrix (border), and the tile
 * is a fixed dark-on-light pair in both themes: a scanner needs that contrast whatever the
 * browser's colour scheme is, so these two colours are deliberately not theme tokens.
 */
import { useMemo } from "preact/hooks";
import { encode } from "uqr";

export function QrCode({ value, size = 176, label }: { value: string; size?: number; label: string }) {
  const matrix = useMemo(() => {
    try {
      return encode(value, { ecc: "M", border: 3 });
    } catch {
      return null;
    }
  }, [value]);
  if (!matrix) return null;

  const rects: { x: number; y: number; w: number }[] = [];
  for (let y = 0; y < matrix.size; y++) {
    const row = matrix.data[y]!;
    let x = 0;
    while (x < matrix.size) {
      if (!row[x]) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < matrix.size && row[x + w]) w++;
      rects.push({ x, y, w });
      x += w;
    }
  }

  return (
    <svg
      class="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      shape-rendering="crispEdges"
      role="img"
      aria-label={label}
    >
      <rect class="qr__light" x="0" y="0" width={matrix.size} height={matrix.size} />
      {rects.map((r) => (
        <rect class="qr__dark" x={r.x} y={r.y} width={r.w} height="1" />
      ))}
    </svg>
  );
}
