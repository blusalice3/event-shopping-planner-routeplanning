import React from 'react';

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
  cursor?: React.CSSProperties['cursor'];
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
  return (
    <div
      ref={containerRef}
      className="relative bg-white dark:bg-slate-800 overflow-hidden"
      style={{
        width: '100%',
        height: '100%',
      }}
    >
      <canvas
        ref={canvasRef}
        onClick={onCanvasClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onPointerCancel={onPointerCancel}
        style={{
          cursor: cursor || (isDragging ? 'grabbing' : 'grab'),
          touchAction: 'none',
        }}
      />
    </div>
  );
};

export default MapCanvasPresentation;
