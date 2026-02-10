import React from 'react';

interface VertexSelectionMode {
  clickedVertices: { row: number; col: number }[];
  [key: string]: any;
}

interface VertexSelectionOverlayProps {
  vertexSelectionMode: VertexSelectionMode;
  onConfirm: () => void;
  onCancel: () => void;
}

const VertexSelectionOverlay: React.FC<VertexSelectionOverlayProps> = ({
  vertexSelectionMode, onConfirm, onCancel,
}) => {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 p-4 min-w-80">
      <div className="text-center mb-3">
        <div className="text-sm font-semibold text-slate-800 dark:text-white mb-1">
          📍 ホールの頂点をクリック ({vertexSelectionMode.clickedVertices.length}/4〜6)
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
          クリック順に多角形を作成します
        </div>
        {vertexSelectionMode.clickedVertices.length > 0 && (
          <div className="text-xs text-slate-500 dark:text-slate-400">
            選択: {vertexSelectionMode.clickedVertices.map(v => `(${v.row},${v.col})`).join(' → ')}
          </div>
        )}
      </div>
      <div className="flex gap-2 justify-center">
        <button
          onClick={onConfirm}
          disabled={vertexSelectionMode.clickedVertices.length < 4}
          className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          確定
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
        >
          キャンセル
        </button>
      </div>
    </div>
  );
};

export default VertexSelectionOverlay;
