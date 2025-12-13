import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { DayMapData, BlockDefinition, CellData, NumberCellInfo, CellGroup } from '../../types';

interface BlockDefinitionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  mapData: DayMapData;
  onUpdateBlocks: (blocks: BlockDefinition[]) => void;
}

const BLOCK_COLORS = [
  '#E3F2FD', '#E8F5E9', '#FFF3E0', '#F3E5F5', '#E0F7FA',
  '#FBE9E7', '#F1F8E9', '#FCE4EC', '#E8EAF6', '#FFFDE7',
  '#EFEBE9', '#ECEFF1',
];

type SortDirection = 'asc' | 'desc';
type EditMode = 'normal' | 'wall';
type CellClickMode = 'corner' | 'rangeStart' | 'rangeEnd' | 'individual' | null;

const BlockDefinitionPanel: React.FC<BlockDefinitionPanelProps> = ({
  isOpen, onClose, mapData, onUpdateBlocks,
}) => {
  const [blocks, setBlocks] = useState<BlockDefinition[]>(mapData.blocks);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState<number | null>(null);
  const [editingBlock, setEditingBlock] = useState<Partial<BlockDefinition> | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [editMode, setEditMode] = useState<EditMode>('normal');
  const [cellClickMode, setCellClickMode] = useState<CellClickMode>(null);
  const [clickedCorners, setClickedCorners] = useState<{ row: number; col: number }[]>([]);
  const [wallCellGroups, setWallCellGroups] = useState<CellGroup[]>([]);
  const [rangeStart, setRangeStart] = useState<{ row: number; col: number } | null>(null);
  const [individualCells, setIndividualCells] = useState<{ row: number; col: number }[]>([]);

  const cellsMap = useMemo(() => {
    const map = new Map<string, CellData>();
    mapData.cells.forEach(cell => map.set(`${cell.row}-${cell.col}`, cell));
    return map;
  }, [mapData.cells]);

  const sortedBlocks = useMemo(() => {
    return [...blocks].sort((a, b) => {
      const cmp = a.name.localeCompare(b.name, 'ja');
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [blocks, sortDirection]);

  const detectNumberCells = useCallback((startRow: number, startCol: number, endRow: number, endCol: number) => {
    const cells: NumberCellInfo[] = [];
    const minR = Math.min(startRow, endRow), maxR = Math.max(startRow, endRow);
    const minC = Math.min(startCol, endCol), maxC = Math.max(startCol, endCol);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const cell = cellsMap.get(`${r}-${c}`);
        if (cell && !cell.isMerged && cell.value !== null) {
          const num = typeof cell.value === 'number' ? cell.value : parseFloat(String(cell.value));
          if (!isNaN(num) && num > 0 && num <= 100) cells.push({ row: r, col: c, value: num });
        }
      }
    }
    return cells.sort((a, b) => a.value - b.value);
  }, [cellsMap]);

  const handleCellClick = useCallback((row: number, col: number) => {
    if (!cellClickMode) return;
    if (cellClickMode === 'corner') {
      setClickedCorners(prev => {
        const next = [...prev, { row, col }];
        if (next.length === 4) {
          const rows = next.map(c => c.row), cols = next.map(c => c.col);
          const range = { startRow: Math.min(...rows), startCol: Math.min(...cols), endRow: Math.max(...rows), endCol: Math.max(...cols) };
          const numCells = detectNumberCells(range.startRow, range.startCol, range.endRow, range.endCol);
          setEditingBlock(eb => ({ ...eb, ...range, numberCells: numCells }));
          setCellClickMode(null);
          return [];
        }
        return next;
      });
    } else if (cellClickMode === 'rangeStart') {
      setRangeStart({ row, col });
      setCellClickMode('rangeEnd');
    } else if (cellClickMode === 'rangeEnd' && rangeStart) {
      const g: CellGroup = {
        type: 'range',
        startRow: Math.min(rangeStart.row, row), startCol: Math.min(rangeStart.col, col),
        endRow: Math.max(rangeStart.row, row), endCol: Math.max(rangeStart.col, col),
      };
      setWallCellGroups(prev => prev.length >= 6 ? prev : [...prev, g]);
      setRangeStart(null);
      setCellClickMode(null);
    } else if (cellClickMode === 'individual') {
      setIndividualCells(prev => {
        const idx = prev.findIndex(c => c.row === row && c.col === col);
        return idx >= 0 ? prev.filter((_, i) => i !== idx) : [...prev, { row, col }];
      });
    }
  }, [cellClickMode, rangeStart, detectNumberCells]);

  useEffect(() => {
    const handler = (e: CustomEvent) => handleCellClick(e.detail.row, e.detail.col);
    window.addEventListener('mapCellClick', handler as EventListener);
    return () => window.removeEventListener('mapCellClick', handler as EventListener);
  }, [handleCellClick]);

  const wallBlockNumberCells = useMemo(() => {
    if (editMode !== 'wall') return [];
    const all: NumberCellInfo[] = [];
    wallCellGroups.forEach(g => {
      if (g.type === 'range' && g.startRow && g.startCol && g.endRow && g.endCol) {
        all.push(...detectNumberCells(g.startRow, g.startCol, g.endRow, g.endCol));
      } else if (g.type === 'individual' && g.cells) {
        g.cells.forEach(c => {
          const cell = cellsMap.get(`${c.row}-${c.col}`);
          if (cell && cell.value !== null && cell.value !== undefined) {
            const num = typeof cell.value === 'number' ? cell.value : parseFloat(String(cell.value));
            if (!isNaN(num) && num > 0 && num <= 100) all.push({ row: c.row, col: c.col, value: num });
          }
        });
      }
    });
    return all.filter((c, i, s) => i === s.findIndex(x => x.row === c.row && x.col === c.col)).sort((a, b) => a.value - b.value);
  }, [editMode, wallCellGroups, detectNumberCells, cellsMap]);

  const previewNumberCells = useMemo(() => {
    if (editMode === 'wall') return wallBlockNumberCells;
    if (!editingBlock?.startRow || !editingBlock?.endRow) return [];
    return detectNumberCells(editingBlock.startRow, editingBlock.startCol || 1, editingBlock.endRow, editingBlock.endCol || 1);
  }, [editingBlock, editMode, wallBlockNumberCells, detectNumberCells]);

  const handleSaveBlock = useCallback(() => {
    if (!editingBlock?.name?.trim()) { alert('ブロック名を入力してください'); return; }
    const name = editingBlock.name.trim();
    if (isAddingNew && blocks.find(b => b.name === name)) {
      if (!confirm(`「${name}」は既に存在します。置き換えますか？`)) return;
      setBlocks(prev => prev.filter(b => b.name !== name));
    }
    let saved: BlockDefinition;
    if (editMode === 'wall') {
      if (!wallCellGroups.length) { alert('セル群を定義してください'); return; }
      let minR = Infinity, minC = Infinity, maxR = 0, maxC = 0;
      wallCellGroups.forEach(g => {
        if (g.type === 'range') {
          minR = Math.min(minR, g.startRow || Infinity); minC = Math.min(minC, g.startCol || Infinity);
          maxR = Math.max(maxR, g.endRow || 0); maxC = Math.max(maxC, g.endCol || 0);
        } else if (g.cells) g.cells.forEach(c => { minR = Math.min(minR, c.row); minC = Math.min(minC, c.col); maxR = Math.max(maxR, c.row); maxC = Math.max(maxC, c.col); });
      });
      saved = { name, startRow: minR, startCol: minC, endRow: maxR, endCol: maxC, numberCells: wallBlockNumberCells, color: editingBlock.color || BLOCK_COLORS[0], isAutoDetected: false, isWallBlock: true, cellGroups: [...wallCellGroups] };
    } else {
      if (!editingBlock.startRow || !editingBlock.endRow) { alert('4つの角をクリックして範囲を指定してください'); return; }
      saved = { name, startRow: editingBlock.startRow, startCol: editingBlock.startCol || 1, endRow: editingBlock.endRow, endCol: editingBlock.endCol || 1, numberCells: previewNumberCells, color: editingBlock.color || BLOCK_COLORS[0], isAutoDetected: false, isWallBlock: false };
    }
    if (isAddingNew) setBlocks(prev => [...prev, saved]);
    else if (selectedBlockIndex !== null) { const orig = sortedBlocks[selectedBlockIndex]; setBlocks(prev => prev.map(b => b.name === orig.name ? saved : b)); }
    setEditingBlock(null); setSelectedBlockIndex(null); setIsAddingNew(false); setCellClickMode(null); setClickedCorners([]); setWallCellGroups([]);
  }, [editingBlock, isAddingNew, selectedBlockIndex, editMode, wallCellGroups, wallBlockNumberCells, previewNumberCells, blocks, sortedBlocks]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">ブロック定義</h2>
          <button onClick={() => { setBlocks(mapData.blocks); onClose(); }} className="text-2xl text-slate-500 hover:text-slate-700">✕</button>
        </div>

        {cellClickMode && (
          <div className="px-6 py-2 bg-blue-50 dark:bg-blue-900/30 border-b border-blue-200">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-blue-800 dark:text-blue-200">
                {cellClickMode === 'corner' && `📍 角をクリック (${clickedCorners.length}/4)`}
                {cellClickMode === 'rangeStart' && '📍 範囲の開始セルをクリック'}
                {cellClickMode === 'rangeEnd' && '📍 範囲の終了セルをクリック'}
                {cellClickMode === 'individual' && `📍 個別セルをクリック (${individualCells.length}個)`}
              </span>
              <button onClick={() => { setCellClickMode(null); setClickedCorners([]); setRangeStart(null); }} className="text-sm text-blue-600">キャンセル</button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto p-6">
          <div className="grid grid-cols-2 gap-6">
            {/* 左: ブロック一覧 */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">定義済み ({blocks.length}件)</h3>
                <div className="flex gap-2">
                  <button onClick={() => setSortDirection(d => d === 'asc' ? 'desc' : 'asc')} className="px-2 py-1 text-xs rounded bg-slate-200 dark:bg-slate-700">{sortDirection === 'asc' ? '↑昇順' : '↓降順'}</button>
                  <button onClick={() => { setIsAddingNew(true); setSelectedBlockIndex(null); setEditMode('normal'); setEditingBlock({ name: '', startRow: 0, startCol: 0, endRow: 0, endCol: 0, numberCells: [], color: BLOCK_COLORS[blocks.length % BLOCK_COLORS.length] }); setClickedCorners([]); setCellClickMode(null); setWallCellGroups([]); }} className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white">+ 新規</button>
                  <button onClick={() => confirm('全て削除？') && setBlocks([])} className="px-3 py-1.5 text-xs rounded bg-red-100 text-red-700">全削除</button>
                </div>
              </div>
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {sortedBlocks.length === 0 ? <p className="text-sm text-slate-500 text-center py-8">ブロックなし</p> : sortedBlocks.map((b, i) => (
                  <div key={`${b.name}-${i}`} className={`p-3 rounded-lg border cursor-pointer ${selectedBlockIndex === i ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 hover:bg-slate-50'}`} onClick={() => { setSelectedBlockIndex(i); setEditingBlock({ ...b }); setIsAddingNew(false); setEditMode(b.isWallBlock ? 'wall' : 'normal'); setClickedCorners([]); setCellClickMode(null); setWallCellGroups(b.isWallBlock && b.cellGroups ? [...b.cellGroups] : []); }}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded flex items-center justify-center text-sm font-bold" style={{ backgroundColor: b.color || '#E3F2FD' }}>{b.name}</div>
                        <div>
                          <div className="text-sm font-medium">{b.name}{b.isWallBlock && <span className="ml-2 text-xs text-orange-600">[壁]</span>}</div>
                          <div className="text-xs text-slate-500">{b.numberCells.length}セル</div>
                        </div>
                      </div>
                      <button onClick={e => { e.stopPropagation(); if (confirm(`「${b.name}」を削除？`)) { setBlocks(prev => prev.filter(x => x.name !== b.name)); setSelectedBlockIndex(null); setEditingBlock(null); } }} className="p-1 text-red-500">🗑️</button>
                    </div>
                    {b.isAutoDetected && <div className="mt-1 text-xs text-blue-600">⚡自動検出</div>}
                  </div>
                ))}
              </div>
            </div>

            {/* 右: 編集 */}
            <div>
              {editingBlock ? (
                <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold">{isAddingNew ? '新規追加' : '編集'}</h3>
                    <button onClick={() => { setEditMode(editMode === 'normal' ? 'wall' : 'normal'); setWallCellGroups([]); }} className={`px-2 py-1 text-xs rounded ${editMode === 'wall' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>{editMode === 'wall' ? '通常モード' : '壁ブロック'}</button>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">ブロック名</label>
                      <input type="text" value={editingBlock.name || ''} onChange={e => setEditingBlock(eb => ({ ...eb, name: e.target.value }))} placeholder="例: ア, め" className="w-full px-3 py-2 text-sm border rounded bg-white dark:bg-slate-800" />
                    </div>
                    {editMode === 'normal' ? (
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">範囲指定</label>
                        <button onClick={() => { setCellClickMode('corner'); setClickedCorners([]); }} className="w-full px-3 py-2 text-sm rounded bg-blue-100 text-blue-700">📍 4つの角をクリック</button>
                        {clickedCorners.length > 0 && <div className="mt-2 text-xs text-slate-600">選択: {clickedCorners.map(c => `(${c.row},${c.col})`).join(', ')}</div>}
                        {editingBlock.startRow && editingBlock.endRow && <div className="mt-2 p-2 bg-green-50 rounded text-xs text-green-700">範囲: 行{editingBlock.startRow}-{editingBlock.endRow}, 列{editingBlock.startCol}-{editingBlock.endCol}</div>}
                      </div>
                    ) : (
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">セル群 (最大6)</label>
                        {wallCellGroups.length > 0 && <div className="mb-2 space-y-1">{wallCellGroups.map((g, i) => <div key={i} className="flex items-center justify-between p-2 bg-white dark:bg-slate-800 rounded border"><span className="text-xs">{g.type === 'range' ? `範囲(${g.startRow},${g.startCol})-(${g.endRow},${g.endCol})` : `個別${g.cells?.length}セル`}</span><button onClick={() => setWallCellGroups(prev => prev.filter((_, j) => j !== i))} className="text-red-500 text-sm">✕</button></div>)}</div>}
                        <div className="flex gap-2">
                          <button onClick={() => setCellClickMode('rangeStart')} disabled={wallCellGroups.length >= 6} className="flex-1 px-3 py-2 text-xs rounded bg-blue-100 text-blue-700 disabled:opacity-50">+ 範囲追加</button>
                          <button onClick={() => { setIndividualCells([]); setCellClickMode('individual'); }} disabled={wallCellGroups.length >= 6} className="flex-1 px-3 py-2 text-xs rounded bg-orange-100 text-orange-700 disabled:opacity-50">+ 個別追加</button>
                        </div>
                        {cellClickMode === 'individual' && <div className="mt-3"><div className="text-xs text-slate-600 mb-2">選択中: {individualCells.map(c => `(${c.row},${c.col})`).join(', ')}</div><button onClick={() => { if (!individualCells.length) { alert('セルを選択'); return; } setWallCellGroups(prev => prev.length >= 6 ? prev : [...prev, { type: 'individual', cells: [...individualCells] }]); setIndividualCells([]); setCellClickMode(null); }} className="w-full px-3 py-2 text-sm rounded bg-green-600 text-white">確定</button></div>}
                      </div>
                    )}
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">色</label>
                      <div className="flex flex-wrap gap-2">{BLOCK_COLORS.map(c => <button key={c} onClick={() => setEditingBlock(eb => ({ ...eb, color: c }))} className={`w-8 h-8 rounded border-2 ${editingBlock.color === c ? 'border-blue-500' : 'border-transparent'}`} style={{ backgroundColor: c }} />)}</div>
                    </div>
                    <div className="p-3 bg-white dark:bg-slate-800 rounded border">
                      <div className="text-xs font-medium text-slate-600 mb-2">検出セル: {previewNumberCells.length}個</div>
                      {previewNumberCells.length > 0 ? <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">{previewNumberCells.map((c, i) => <span key={i} className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded">{c.value}</span>)}</div> : <p className="text-xs text-slate-500">範囲を指定してください</p>}
                    </div>
                    <div className="flex gap-2 pt-2">
                      <button onClick={handleSaveBlock} className="flex-1 px-4 py-2 text-sm rounded bg-blue-600 text-white">{isAddingNew ? '追加' : '保存'}</button>
                      <button onClick={() => { setEditingBlock(null); setSelectedBlockIndex(null); setIsAddingNew(false); setCellClickMode(null); setClickedCorners([]); setWallCellGroups([]); setEditMode('normal'); }} className="px-4 py-2 text-sm rounded bg-slate-200 text-slate-700">キャンセル</button>
                    </div>
                  </div>
                </div>
              ) : <div className="p-8 text-center text-slate-500"><p className="mb-2">左から選択して編集</p><p className="text-sm">または「新規」で追加</p></div>}
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-3">
          <button onClick={() => { setBlocks(mapData.blocks); onClose(); }} className="px-4 py-2 text-sm rounded bg-slate-200 text-slate-700">キャンセル</button>
          <button onClick={() => { onUpdateBlocks(blocks); onClose(); }} className="px-4 py-2 text-sm rounded bg-blue-600 text-white">適用</button>
        </div>
      </div>
    </div>
  );
};

export default BlockDefinitionPanel;
