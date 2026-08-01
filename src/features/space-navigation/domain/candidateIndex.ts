export interface CandidateCoordinateInput {
  coordinate: number;
  start: number;
  end: number;
  count: number;
}

export interface CenteredCandidateCoordinateInput {
  coordinate: number;
  centerCoordinate: number;
  rowExtent: number;
  currentIndex: number;
  count: number;
}

export function clampCandidateIndex(index: number, count: number): number {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount === 0) return -1;
  if (!Number.isFinite(index)) return 0;
  return Math.min(safeCount - 1, Math.max(0, Math.round(index)));
}

/**
 * Maps a rail coordinate to equally-sized visit sections.
 */
export function candidateIndexFromCoordinate({
  coordinate,
  start,
  end,
  count,
}: CandidateCoordinateInput): number {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount === 0) return -1;
  if (
    !Number.isFinite(coordinate) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end)
  ) {
    return 0;
  }

  const extent = end - start;
  if (extent <= 0) return 0;
  if (coordinate <= start) return 0;
  if (coordinate >= end) return safeCount - 1;

  const index = Math.floor(((coordinate - start) / extent) * safeCount);
  return Math.min(safeCount - 1, Math.max(0, index));
}

/**
 * Snaps a coordinate in the expanded list to the nearest row relative to its
 * center line. A row below the center advances one visit.
 */
export function candidateIndexFromCenteredCoordinate({
  coordinate,
  centerCoordinate,
  rowExtent,
  currentIndex,
  count,
}: CenteredCandidateCoordinateInput): number {
  if (!Number.isFinite(rowExtent) || rowExtent <= 0) {
    return clampCandidateIndex(currentIndex, count);
  }
  if (!Number.isFinite(coordinate) || !Number.isFinite(centerCoordinate)) {
    return clampCandidateIndex(currentIndex, count);
  }
  const rawDelta = (coordinate - centerCoordinate) / rowExtent;
  const rowDelta = Math.sign(rawDelta) * Math.floor(Math.abs(rawDelta) + 0.5);
  return clampCandidateIndex(currentIndex + rowDelta, count);
}

export function stepCandidateIndex(
  currentIndex: number,
  step: -1 | 1,
  count: number,
): number {
  return clampCandidateIndex(currentIndex + step, count);
}
