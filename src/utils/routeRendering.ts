// ルート描画共通ユーティリティ

export interface CrossingInfo {
  earlierSegIdx: number;
  earlierEdgeIdx: number;
  laterSegIdx: number;
  laterEdgeIdx: number;
  x: number;
  y: number;
  tA: number; // earlier edge 上のパラメトリック位置 (0-1)
  tB: number; // later edge 上のパラメトリック位置 (0-1)
}

export interface PixelEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// 正規化されたエッジキー生成
export function getEdgeKey(r1: number, c1: number, r2: number, c2: number): string {
  if (r1 < r2 || (r1 === r2 && c1 < c2)) {
    return `${r1},${c1}-${r2},${c2}`;
  }
  return `${r2},${c2}-${r1},${c1}`;
}

// 法線方向オフセット計算
export function getOffsetPoints(
  px1: number,
  py1: number,
  px2: number,
  py2: number,
  offset: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = px2 - px1;
  const dy = py2 - py1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { x1: px1, y1: py1, x2: px2, y2: py2 };

  const nx = -dy / len;
  const ny = dx / len;

  return {
    x1: px1 + nx * offset,
    y1: py1 + ny * offset,
    x2: px2 + nx * offset,
    y2: py2 + ny * offset,
  };
}

// 2つの線分の交差点を求める（パラメトリック位置付き）
// 返り値: { x, y, tA, tB } または null（交差しない場合）
// tA: セグメントA上の交差位置 (0-1), tB: セグメントB上の交差位置 (0-1)
export function segmentIntersectionPoint(
  ax1: number, ay1: number, ax2: number, ay2: number,
  bx1: number, by1: number, bx2: number, by2: number,
): { x: number; y: number; tA: number; tB: number } | null {
  const dax = ax2 - ax1;
  const day = ay2 - ay1;
  const dbx = bx2 - bx1;
  const dby = by2 - by1;

  const denom = dax * dby - day * dbx;

  // 平行または重なっている場合
  if (Math.abs(denom) < 1e-9) return null;

  const t = ((bx1 - ax1) * dby - (by1 - ay1) * dbx) / denom;
  const u = ((bx1 - ax1) * day - (by1 - ay1) * dax) / denom;

  // 端点での交差は除外（共有頂点での誤検出を防ぐ）
  const eps = 0.01;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;

  return {
    x: ax1 + t * dax,
    y: ay1 + t * day,
    tA: t,
    tB: u,
  };
}

// 全セグメント間の交差点を検出
// segments: セグメントごとのピクセル座標エッジ配列
export function findAllCrossings(
  segments: PixelEdge[][],
): CrossingInfo[] {
  const crossings: CrossingInfo[] = [];

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const edgesA = segments[i];
      const edgesB = segments[j];

      for (let ei = 0; ei < edgesA.length; ei++) {
        const eA = edgesA[ei];
        for (let ej = 0; ej < edgesB.length; ej++) {
          const eB = edgesB[ej];

          const result = segmentIntersectionPoint(
            eA.x1, eA.y1, eA.x2, eA.y2,
            eB.x1, eB.y1, eB.x2, eB.y2,
          );

          if (result) {
            crossings.push({
              earlierSegIdx: i,
              earlierEdgeIdx: ei,
              laterSegIdx: j,
              laterEdgeIdx: ej,
              x: result.x,
              y: result.y,
              tA: result.tA,
              tB: result.tB,
            });
          }
        }
      }
    }
  }

  return crossings;
}

// 交差情報をエッジキーでインデックス化するルックアップ構築
export function buildCrossingLookup(
  crossings: CrossingInfo[],
): Map<string, CrossingInfo[]> {
  const lookup = new Map<string, CrossingInfo[]>();

  for (const c of crossings) {
    // 先行セグメントのエッジ
    const earlierKey = `${c.earlierSegIdx}-${c.earlierEdgeIdx}`;
    if (!lookup.has(earlierKey)) lookup.set(earlierKey, []);
    lookup.get(earlierKey)!.push(c);

    // 後行セグメントのエッジ
    const laterKey = `${c.laterSegIdx}-${c.laterEdgeIdx}`;
    if (!lookup.has(laterKey)) lookup.set(laterKey, []);
    lookup.get(laterKey)!.push(c);
  }

  return lookup;
}

// 飛び越し線のギャップ半径とアーチ高さを計算
export function getBridgeParams(cellSize: number): { gapRadius: number; archHeight: number } {
  return {
    gapRadius: Math.max(4, cellSize * 0.15),
    archHeight: Math.max(5, cellSize * 0.2),
  };
}

// エッジを交差点でサブセグメントに分割（先行セグメント用：ギャップを空ける）
export function splitEdgeWithGaps(
  x1: number, y1: number, x2: number, y2: number,
  crossingsOnEdge: { t: number; gapRadius: number }[],
): { x1: number; y1: number; x2: number; y2: number }[] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [];

  // t値でソート
  const sorted = [...crossingsOnEdge].sort((a, b) => a.t - b.t);

  const subSegments: { x1: number; y1: number; x2: number; y2: number }[] = [];
  let currentT = 0;

  for (const crossing of sorted) {
    const gapT = crossing.gapRadius / len;
    const gapStart = Math.max(0, crossing.t - gapT);
    const gapEnd = Math.min(1, crossing.t + gapT);

    if (currentT < gapStart) {
      subSegments.push({
        x1: x1 + dx * currentT,
        y1: y1 + dy * currentT,
        x2: x1 + dx * gapStart,
        y2: y1 + dy * gapStart,
      });
    }
    currentT = gapEnd;
  }

  if (currentT < 1) {
    subSegments.push({
      x1: x1 + dx * currentT,
      y1: y1 + dy * currentT,
      x2,
      y2,
    });
  }

  return subSegments;
}

// 飛び越しアーチの描画パラメータを計算（後行セグメント用）
export interface ArchDrawParams {
  // アーチ前の直線部分
  preX: number; preY: number;
  // アーチ開始点
  archStartX: number; archStartY: number;
  // 制御点（quadraticCurveTo用）
  cpX: number; cpY: number;
  // アーチ終了点
  archEndX: number; archEndY: number;
  // アーチ後の直線部分
  postX: number; postY: number;
}

export function computeArchParams(
  x1: number, y1: number, x2: number, y2: number,
  crossingT: number,
  gapRadius: number,
  archHeight: number,
): ArchDrawParams {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);

  const gapT = len > 0 ? gapRadius / len : 0;
  const archStartT = Math.max(0, crossingT - gapT);
  const archEndT = Math.min(1, crossingT + gapT);

  // 交差点の座標
  const cx = x1 + dx * crossingT;
  const cy = y1 + dy * crossingT;

  // 法線方向（上に持ち上げる）
  const nx = len > 0 ? -dy / len : 0;
  const ny = len > 0 ? dx / len : 0;

  return {
    preX: x1, preY: y1,
    archStartX: x1 + dx * archStartT,
    archStartY: y1 + dy * archStartT,
    cpX: cx + nx * archHeight,
    cpY: cy + ny * archHeight,
    archEndX: x1 + dx * archEndT,
    archEndY: y1 + dy * archEndT,
    postX: x2, postY: y2,
  };
}

// Canvas上でエッジを飛び越し線付きで描画する共通関数
export function drawEdgeWithBridges(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  segIdx: number,
  edgeIdx: number,
  crossingLookup: Map<string, CrossingInfo[]>,
  bridgeParams: { gapRadius: number; archHeight: number },
  strokeStyle: string,
  lineWidth: number,
): void {
  const key = `${segIdx}-${edgeIdx}`;
  const crossingsOnThisEdge = crossingLookup.get(key);

  if (!crossingsOnThisEdge || crossingsOnThisEdge.length === 0) {
    // 交差なし：通常描画
    ctx.beginPath();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    return;
  }

  // このエッジが先行（earlier）か後行（later）かで処理を分ける
  const asEarlier = crossingsOnThisEdge.filter(
    (c) => c.earlierSegIdx === segIdx && c.earlierEdgeIdx === edgeIdx,
  );
  const asLater = crossingsOnThisEdge.filter(
    (c) => c.laterSegIdx === segIdx && c.laterEdgeIdx === edgeIdx,
  );

  if (asEarlier.length > 0 && asLater.length === 0) {
    // 先行セグメント：ギャップを空けて描画
    const gaps = asEarlier.map((c) => ({
      t: c.tA,
      gapRadius: bridgeParams.gapRadius,
    }));
    const subSegs = splitEdgeWithGaps(x1, y1, x2, y2, gaps);

    for (const sub of subSegs) {
      ctx.beginPath();
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.setLineDash([]);
      ctx.moveTo(sub.x1, sub.y1);
      ctx.lineTo(sub.x2, sub.y2);
      ctx.stroke();
    }
  } else if (asLater.length > 0) {
    // 後行セグメント：アーチで飛び越し描画
    // 交差点をtB値でソート
    const sortedCrossings = [...asLater].sort((a, b) => a.tB - b.tB);

    // 先行としてのギャップも合わせて考慮
    const allGaps = asEarlier.map((c) => ({
      t: c.tA,
      gapRadius: bridgeParams.gapRadius,
    }));

    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    const gapT = len > 0 ? bridgeParams.gapRadius / len : 0;

    // 区間をアーチと直線に分けて描画
    let currentT = 0;

    for (const crossing of sortedCrossings) {
      const archStartT = Math.max(0, crossing.tB - gapT);
      const archEndT = Math.min(1, crossing.tB + gapT);

      // アーチ前の直線部分
      if (currentT < archStartT) {
        // 先行ギャップを考慮してサブセグメント化
        const lineX1 = x1 + dx * currentT;
        const lineY1 = y1 + dy * currentT;
        const lineX2 = x1 + dx * archStartT;
        const lineY2 = y1 + dy * archStartT;

        const relevantGaps = allGaps
          .filter((g) => g.t > currentT && g.t < archStartT)
          .map((g) => ({ ...g }));

        if (relevantGaps.length > 0) {
          const subSegs = splitEdgeWithGaps(lineX1, lineY1, lineX2, lineY2, relevantGaps.map((g) => ({
            t: (g.t - currentT) / (archStartT - currentT),
            gapRadius: g.gapRadius,
          })));
          for (const sub of subSegs) {
            ctx.beginPath();
            ctx.moveTo(sub.x1, sub.y1);
            ctx.lineTo(sub.x2, sub.y2);
            ctx.stroke();
          }
        } else {
          ctx.beginPath();
          ctx.moveTo(lineX1, lineY1);
          ctx.lineTo(lineX2, lineY2);
          ctx.stroke();
        }
      }

      // アーチ描画
      const archParams = computeArchParams(
        x1, y1, x2, y2,
        crossing.tB,
        bridgeParams.gapRadius,
        bridgeParams.archHeight,
      );

      ctx.beginPath();
      ctx.moveTo(archParams.archStartX, archParams.archStartY);
      ctx.quadraticCurveTo(archParams.cpX, archParams.cpY, archParams.archEndX, archParams.archEndY);
      ctx.stroke();

      currentT = archEndT;
    }

    // 残りの直線部分
    if (currentT < 1) {
      const lineX1 = x1 + dx * currentT;
      const lineY1 = y1 + dy * currentT;

      const relevantGaps = allGaps
        .filter((g) => g.t > currentT && g.t < 1)
        .map((g) => ({ ...g }));

      if (relevantGaps.length > 0) {
        const subSegs = splitEdgeWithGaps(lineX1, lineY1, x2, y2, relevantGaps.map((g) => ({
          t: (g.t - currentT) / (1 - currentT),
          gapRadius: g.gapRadius,
        })));
        for (const sub of subSegs) {
          ctx.beginPath();
          ctx.moveTo(sub.x1, sub.y1);
          ctx.lineTo(sub.x2, sub.y2);
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.moveTo(lineX1, lineY1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
  } else {
    // 両方の役割がある場合（先行かつ後行）
    // 後行のアーチ処理を優先
    const sortedLater = [...asLater].sort((a, b) => a.tB - b.tB);
    const earlierGaps = asEarlier.map((c) => ({
      t: c.tA,
      gapRadius: bridgeParams.gapRadius,
    }));

    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    const gapT = len > 0 ? bridgeParams.gapRadius / len : 0;

    let currentT = 0;

    for (const crossing of sortedLater) {
      const archStartT = Math.max(0, crossing.tB - gapT);
      const archEndT = Math.min(1, crossing.tB + gapT);

      if (currentT < archStartT) {
        const subSegs = splitEdgeWithGaps(
          x1 + dx * currentT, y1 + dy * currentT,
          x1 + dx * archStartT, y1 + dy * archStartT,
          earlierGaps
            .filter((g) => g.t > currentT && g.t < archStartT)
            .map((g) => ({
              t: (g.t - currentT) / (archStartT - currentT),
              gapRadius: g.gapRadius,
            })),
        );
        for (const sub of subSegs) {
          ctx.beginPath();
          ctx.moveTo(sub.x1, sub.y1);
          ctx.lineTo(sub.x2, sub.y2);
          ctx.stroke();
        }
      }

      const archParams = computeArchParams(x1, y1, x2, y2, crossing.tB, bridgeParams.gapRadius, bridgeParams.archHeight);
      ctx.beginPath();
      ctx.moveTo(archParams.archStartX, archParams.archStartY);
      ctx.quadraticCurveTo(archParams.cpX, archParams.cpY, archParams.archEndX, archParams.archEndY);
      ctx.stroke();

      currentT = archEndT;
    }

    if (currentT < 1) {
      const subSegs = splitEdgeWithGaps(
        x1 + dx * currentT, y1 + dy * currentT,
        x2, y2,
        earlierGaps
          .filter((g) => g.t > currentT && g.t < 1)
          .map((g) => ({
            t: (g.t - currentT) / (1 - currentT),
            gapRadius: g.gapRadius,
          })),
      );
      for (const sub of subSegs) {
        ctx.beginPath();
        ctx.moveTo(sub.x1, sub.y1);
        ctx.lineTo(sub.x2, sub.y2);
        ctx.stroke();
      }
    }
  }
}
