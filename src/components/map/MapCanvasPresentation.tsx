import React from "react";

type MapCanvasPresentationProps = {
  containerRef: React.RefObject<HTMLDivElement>;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  isDragging: boolean;
  onCanvasClick: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerLeave: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  cursor?: "grab" | "grabbing" | "crosshair";
};

const MapCanvasPresentation: React.FC<MapCanvasPresentationProps> = ({
  containerRef,
  canvasRef,
  isDragging,
  onCanvasClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerLeave,
  onPointerCancel,
  cursor,
}) => {
  const resolvedCursor = cursor || (isDragging ? "grabbing" : "grab");
  const cursorClassName =
    resolvedCursor === "crosshair"
      ? "cursor-crosshair"
      : resolvedCursor === "grabbing"
        ? "cursor-grabbing"
        : "cursor-grab";

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-white dark:bg-slate-800"
    >
      <canvas
        ref={canvasRef}
        onClick={onCanvasClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onPointerCancel={onPointerCancel}
        className={`block h-full w-full touch-none ${cursorClassName}`}
      />
    </div>
  );
};

export default MapCanvasPresentation;
