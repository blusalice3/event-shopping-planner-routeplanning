export type MapRoutePolygonPoint = { row: number; col: number };

const EPSILON = 1e-9;

export function isPointOnSegment(
  row: number,
  col: number,
  a: MapRoutePolygonPoint,
  b: MapRoutePolygonPoint,
): boolean {
  const cross = (col - a.col) * (b.row - a.row) - (row - a.row) * (b.col - a.col);
  if (Math.abs(cross) > EPSILON) return false;

  return (
    row >= Math.min(a.row, b.row) - EPSILON &&
    row <= Math.max(a.row, b.row) + EPSILON &&
    col >= Math.min(a.col, b.col) - EPSILON &&
    col <= Math.max(a.col, b.col) + EPSILON
  );
}

export function isPointInPolygonInclusive(
  row: number,
  col: number,
  vertices: MapRoutePolygonPoint[],
): boolean {
  if (vertices.length < 3) return false;

  for (let i = 0; i < vertices.length; i += 1) {
    if (isPointOnSegment(row, col, vertices[i], vertices[(i + 1) % vertices.length])) {
      return true;
    }
  }

  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const vi = vertices[i];
    const vj = vertices[j];
    if (
      vi.col > col !== vj.col > col &&
      row < ((vj.row - vi.row) * (col - vi.col)) / (vj.col - vi.col) + vi.row
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function orientation(a: MapRoutePolygonPoint, b: MapRoutePolygonPoint, c: MapRoutePolygonPoint) {
  return (b.col - a.col) * (c.row - a.row) - (b.row - a.row) * (c.col - a.col);
}

function addUniqueParam(params: number[], value: number): void {
  if (value < -EPSILON || value > 1 + EPSILON) return;
  const clamped = Math.max(0, Math.min(1, value));
  if (!params.some((existing) => Math.abs(existing - clamped) < EPSILON)) {
    params.push(clamped);
  }
}

function collectSegmentIntersectionParams(
  params: number[],
  start: MapRoutePolygonPoint,
  end: MapRoutePolygonPoint,
  edgeStart: MapRoutePolygonPoint,
  edgeEnd: MapRoutePolygonPoint,
): void {
  const r = { row: end.row - start.row, col: end.col - start.col };
  const s = { row: edgeEnd.row - edgeStart.row, col: edgeEnd.col - edgeStart.col };
  const denominator = r.col * s.row - r.row * s.col;
  const qp = { row: edgeStart.row - start.row, col: edgeStart.col - start.col };

  if (Math.abs(denominator) < EPSILON) {
    if (Math.abs(orientation(start, end, edgeStart)) > EPSILON) return;
    const useCol = Math.abs(r.col) >= Math.abs(r.row);
    const axisStart = useCol ? start.col : start.row;
    const axisEnd = useCol ? end.col : end.row;
    const axisDelta = axisEnd - axisStart;
    if (Math.abs(axisDelta) < EPSILON) return;
    addUniqueParam(params, ((useCol ? edgeStart.col : edgeStart.row) - axisStart) / axisDelta);
    addUniqueParam(params, ((useCol ? edgeEnd.col : edgeEnd.row) - axisStart) / axisDelta);
    return;
  }

  const t = (qp.col * s.row - qp.row * s.col) / denominator;
  const u = (qp.col * r.row - qp.row * r.col) / denominator;
  if (t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON) {
    addUniqueParam(params, t);
  }
}

export function isSegmentInPolygonInclusive(
  start: MapRoutePolygonPoint,
  end: MapRoutePolygonPoint,
  vertices: MapRoutePolygonPoint[],
): boolean {
  if (!isPointInPolygonInclusive(start.row, start.col, vertices)) return false;
  if (!isPointInPolygonInclusive(end.row, end.col, vertices)) return false;

  const params = [0, 1];
  for (let i = 0; i < vertices.length; i += 1) {
    collectSegmentIntersectionParams(params, start, end, vertices[i], vertices[(i + 1) % vertices.length]);
  }
  params.sort((a, b) => a - b);

  for (let i = 0; i < params.length - 1; i += 1) {
    const t0 = params[i];
    const t1 = params[i + 1];
    if (t1 - t0 < EPSILON) continue;
    const t = (t0 + t1) / 2;
    const row = start.row + (end.row - start.row) * t;
    const col = start.col + (end.col - start.col) * t;
    if (!isPointInPolygonInclusive(row, col, vertices)) return false;
  }

  return true;
}

export function isRoutePathInsideHallPolygon(
  path: MapRoutePolygonPoint[],
  vertices: MapRoutePolygonPoint[],
): boolean {
  if (vertices.length < 3 || path.length === 0) return false;
  for (const point of path) {
    if (!isPointInPolygonInclusive(point.row, point.col, vertices)) return false;
  }
  for (let i = 0; i < path.length - 1; i += 1) {
    if (!isSegmentInPolygonInclusive(path[i], path[i + 1], vertices)) return false;
  }
  return true;
}
