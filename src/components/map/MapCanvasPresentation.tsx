import React from 'react';

type MapCanvasPresentationProps = {
  containerRef: React.RefObject<HTMLDivElement>;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  isDragging: boolean;
  onCanvasClick: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: () => void;
};

const MapCanvasPresentation: React.FC<MapCanvasPresentationProps> = ({
  containerRef,
  canvasRef,
  isDragging,
  onCanvasClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
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
        onPointerLeave={onPointerUp}
        style={{
          cursor: isDragging ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      />
    </div>
  );
};

export default MapCanvasPresentation;
