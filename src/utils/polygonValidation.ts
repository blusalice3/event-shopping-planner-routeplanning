import { HallDefinition } from "../types/map";

export type PolygonValidationIssueCode =
  | "self_intersection"
  | "too_small"
  | "overlap_with_existing";

export interface PolygonValidationIssue {
  code: PolygonValidationIssueCode;
  level: "error" | "warning";
  message: string;
  hallId?: string;
}

export interface PolygonValidationResult {
  area: number;
  issues: PolygonValidationIssue[];
}

export interface ValidateHallPolygonInput {
  vertices: { row: number; col: number }[];
  existingHalls: HallDefinition[];
  mapBounds: { maxRow: number; maxCol: number };
  currentHallId?: string;
  minArea?: number;
  overlapThreshold?: number;
}

const DEFAULT_MIN_AREA = 4;
const DEFAULT_OVERLAP_THRESHOLD = 0.6;
const EPSILON = 1e-9;

const orientation = (
  a: { row: number; col: number },
  b: { row: number; col: number },
  c: { row: number; col: number },
): number => {
  return (b.col - a.col) * (c.row - a.row) - (b.row - a.row) * (c.col - a.col);
};

const isPointOnSegment = (
  p: { row: number; col: number },
  a: { row: number; col: number },
  b: { row: number; col: number },
): boolean => {
  const cross = orientation(a, b, p);
  if (Math.abs(cross) > EPSILON) return false;
  const minCol = Math.min(a.col, b.col) - EPSILON;
  const maxCol = Math.max(a.col, b.col) + EPSILON;
  const minRow = Math.min(a.row, b.row) - EPSILON;
  const maxRow = Math.max(a.row, b.row) + EPSILON;
  return (
    p.col >= minCol && p.col <= maxCol && p.row >= minRow && p.row <= maxRow
  );
};

const segmentsIntersect = (
  a1: { row: number; col: number },
  a2: { row: number; col: number },
  b1: { row: number; col: number },
  b2: { row: number; col: number },
): boolean => {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (Math.abs(o1) <= EPSILON && isPointOnSegment(b1, a1, a2)) return true;
  if (Math.abs(o2) <= EPSILON && isPointOnSegment(b2, a1, a2)) return true;
  if (Math.abs(o3) <= EPSILON && isPointOnSegment(a1, b1, b2)) return true;
  if (Math.abs(o4) <= EPSILON && isPointOnSegment(a2, b1, b2)) return true;
  return false;
};

const hasSelfIntersection = (
  vertices: { row: number; col: number }[],
): boolean => {
  const n = vertices.length;
  if (n < 4) return false;

  for (let i = 0; i < n; i++) {
    const a1 = vertices[i];
    const a2 = vertices[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1) continue;
      if (i === 0 && j === n - 1) continue;
      const b1 = vertices[j];
      const b2 = vertices[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }

  return false;
};

export const calculatePolygonArea = (
  vertices: { row: number; col: number }[],
): number => {
  if (vertices.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < vertices.length; i++) {
    const current = vertices[i];
    const next = vertices[(i + 1) % vertices.length];
    sum += current.col * next.row - next.col * current.row;
  }
  return Math.abs(sum) / 2;
};

const isPointInPolygonInclusive = (
  row: number,
  col: number,
  vertices: { row: number; col: number }[],
): boolean => {
  if (vertices.length < 3) return false;

  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    if (isPointOnSegment({ row, col }, a, b)) return true;
  }

  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
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
};

const getCoveredCells = (
  vertices: { row: number; col: number }[],
  maxRow: number,
  maxCol: number,
): Set<string> => {
  const cells = new Set<string>();
  for (let row = 1; row <= maxRow; row++) {
    for (let col = 1; col <= maxCol; col++) {
      if (isPointInPolygonInclusive(row, col, vertices)) {
        cells.add(`${row}-${col}`);
      }
    }
  }
  return cells;
};

export const validateHallPolygon = ({
  vertices,
  existingHalls,
  mapBounds,
  currentHallId,
  minArea = DEFAULT_MIN_AREA,
  overlapThreshold = DEFAULT_OVERLAP_THRESHOLD,
}: ValidateHallPolygonInput): PolygonValidationResult => {
  const issues: PolygonValidationIssue[] = [];
  const area = calculatePolygonArea(vertices);

  if (vertices.length < 4) {
    issues.push({
      code: "too_small",
      level: "error",
      message: "頂点は4個以上で定義してください。",
    });
    return { area, issues };
  }

  if (hasSelfIntersection(vertices)) {
    issues.push({
      code: "self_intersection",
      level: "error",
      message: "多角形が自己交差しています。",
    });
  }

  if (area < minArea) {
    issues.push({
      code: "too_small",
      level: "error",
      message: `多角形の面積が小さすぎます（面積: ${area.toFixed(2)}）。`,
    });
  }

  const currentCells = getCoveredCells(
    vertices,
    mapBounds.maxRow,
    mapBounds.maxCol,
  );
  if (currentCells.size === 0) {
    issues.push({
      code: "too_small",
      level: "error",
      message: "セルに重なる領域がありません。",
    });
  }

  existingHalls
    .filter((hall) => hall.id !== currentHallId && hall.vertices.length >= 4)
    .forEach((hall) => {
      const hallCells = getCoveredCells(
        hall.vertices,
        mapBounds.maxRow,
        mapBounds.maxCol,
      );
      if (hallCells.size === 0 || currentCells.size === 0) return;

      let intersectionCount = 0;
      currentCells.forEach((cell) => {
        if (hallCells.has(cell)) intersectionCount++;
      });
      if (intersectionCount === 0) return;

      const overlapRatioNew = intersectionCount / currentCells.size;
      const overlapRatioExisting = intersectionCount / hallCells.size;
      const overlapRatio = Math.max(overlapRatioNew, overlapRatioExisting);
      if (overlapRatio >= overlapThreshold) {
        issues.push({
          code: "overlap_with_existing",
          level: "warning",
          hallId: hall.id,
          message: `既存ホール「${hall.name}」と重複率 ${(overlapRatio * 100).toFixed(1)}% です。`,
        });
      }
    });

  return {
    area,
    issues,
  };
};
