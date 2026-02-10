import React from 'react';
import { ShoppingItem, HallDefinition, DayMapData } from '../types';
import { BulkSortDirection } from './HeaderBar';
import ShoppingList from './ShoppingList';

type RangeSelection = { itemId: string; columnType: 'execute' | 'candidate' } | null;

interface EditModeContentProps {
  executeColumnItems: ShoppingItem[];
  candidateColumnItems: ShoppingItem[];
  items: ShoppingItem[];
  activeTab: string;
  eventDates: string[];
  selectedItemIds: Set<string>;
  selectedBlockFilters: Set<string>;
  availableBlocks: string[];
  blocksWithPriorityRemarks: Set<string>;
  candidateNumberSortDirection: BulkSortDirection | null;
  duplicateCircleItemIds: Set<string>;
  highlightedItemId: string | null;
  layoutMode: 'pc' | 'smartphone';
  rangeStart: RangeSelection;
  rangeEnd: RangeSelection;
  handleUpdateItem: (item: ShoppingItem) => void;
  handleMoveItem: (dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate', sourceColumn?: 'execute' | 'candidate') => void;
  handleEditRequest: (item: ShoppingItem) => void;
  handleDeleteRequest: (item: ShoppingItem) => void;
  handleSelectItem: (itemId: string, columnType?: 'execute' | 'candidate') => void;
  handleMoveToExecuteColumn: (...args: any[]) => void;
  handleRemoveFromExecuteColumn: (...args: any[]) => void;
  handleMoveItemUp: (...args: any[]) => void;
  handleMoveItemDown: (...args: any[]) => void;
  handleToggleRangeSelection: (columnType: 'execute' | 'candidate') => void;
  handleToggleBlockFilter: (block: string) => void;
  handleClearBlockFilters: () => void;
  handleCandidateNumberSort: () => void;
  getHallsForDate: (date: string) => HallDefinition[] | undefined;
  getHallOrderForDate: (date: string) => string[] | undefined;
  getMapDataForDate: (date: string) => DayMapData | null | undefined;
}

const EditModeContent: React.FC<EditModeContentProps> = ({
  executeColumnItems, candidateColumnItems, activeTab, eventDates,
  selectedItemIds, selectedBlockFilters, availableBlocks, blocksWithPriorityRemarks,
  candidateNumberSortDirection, duplicateCircleItemIds, highlightedItemId, layoutMode,
  rangeStart, rangeEnd,
  handleUpdateItem, handleMoveItem, handleEditRequest, handleDeleteRequest,
  handleSelectItem, handleMoveToExecuteColumn, handleRemoveFromExecuteColumn,
  handleMoveItemUp, handleMoveItemDown, handleToggleRangeSelection,
  handleToggleBlockFilter, handleClearBlockFilters, handleCandidateNumberSort,
  getHallsForDate, getHallOrderForDate, getMapDataForDate,
}) => {
  const currentDay = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <div className="bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-700 rounded-lg p-3">
          <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-2">実行モード表示列</h3>
          <p className="text-xs text-blue-700 dark:text-blue-300 mb-3">右の候補リストからアイテムを選択して移動</p>
        </div>
        <ShoppingList
          items={executeColumnItems} onUpdateItem={handleUpdateItem}
          onMoveItem={(dragId, hoverId, targetColumn, sourceColumn) => handleMoveItem(dragId, hoverId, targetColumn, sourceColumn)}
          onEditRequest={handleEditRequest} onDeleteRequest={handleDeleteRequest}
          selectedItemIds={selectedItemIds} onSelectItem={handleSelectItem}
          onRemoveFromColumn={handleRemoveFromExecuteColumn} onMoveToColumn={handleMoveToExecuteColumn}
          columnType="execute" currentDay={currentDay}
          onMoveItemUp={handleMoveItemUp} onMoveItemDown={handleMoveItemDown}
          rangeStart={rangeStart} rangeEnd={rangeEnd} onToggleRangeSelection={handleToggleRangeSelection}
          duplicateCircleItemIds={duplicateCircleItemIds} highlightedItemId={highlightedItemId} layoutMode={layoutMode}
          showHallGroups={true}
          hallDefinitions={getHallsForDate(currentDay)}
          hallOrder={getHallOrderForDate(currentDay)}
          mapData={getMapDataForDate(currentDay)}
        />
      </div>
      <div className="space-y-2">
        <div className="bg-slate-100 dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-700 rounded-lg p-3">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">候補リスト</h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">アイテムを選択してヘッダーのボタンから移動</p>
          {availableBlocks.length > 0 && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">ブロックでフィルタ:</span>
                <div className="flex items-center gap-2">
                  {selectedBlockFilters.size > 0 && (
                    <>
                      <button onClick={handleCandidateNumberSort}
                        className={`p-1.5 rounded-md transition-colors ${candidateNumberSortDirection ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300' : 'bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-600'}`}
                        title={candidateNumberSortDirection === 'desc' ? "ナンバー降順 (昇順へ)" : candidateNumberSortDirection === 'asc' ? "ナンバー昇順 (降順へ)" : "ナンバー昇順でソート"}>
                        {candidateNumberSortDirection === 'desc'
                          ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" /></svg>
                          : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" /></svg>}
                      </button>
                      <button onClick={handleClearBlockFilters} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline">すべて解除</button>
                    </>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {availableBlocks.map(block => (
                  <button key={block} onClick={() => handleToggleBlockFilter(block)}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${selectedBlockFilters.has(block) ? 'bg-blue-600 text-white dark:bg-blue-500' : blocksWithPriorityRemarks.has(block) ? 'bg-yellow-300 dark:bg-yellow-600 text-slate-700 dark:text-slate-300 hover:bg-yellow-400 dark:hover:bg-yellow-500 border border-slate-300 dark:border-slate-600' : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 border border-slate-300 dark:border-slate-600'}`}>
                    {block}
                  </button>
                ))}
              </div>
              {selectedBlockFilters.size > 0 && <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">選択中: {selectedBlockFilters.size}件のブロック</p>}
            </div>
          )}
        </div>
        <ShoppingList
          items={candidateColumnItems} onUpdateItem={handleUpdateItem}
          onMoveItem={(dragId, hoverId, targetColumn, sourceColumn) => handleMoveItem(dragId, hoverId, targetColumn, sourceColumn)}
          onEditRequest={handleEditRequest} onDeleteRequest={handleDeleteRequest}
          selectedItemIds={selectedItemIds} onSelectItem={handleSelectItem}
          onMoveToColumn={handleMoveToExecuteColumn} onRemoveFromColumn={handleRemoveFromExecuteColumn}
          columnType="candidate" currentDay={currentDay}
          onMoveItemUp={handleMoveItemUp} onMoveItemDown={handleMoveItemDown}
          rangeStart={rangeStart} rangeEnd={rangeEnd} onToggleRangeSelection={handleToggleRangeSelection}
          duplicateCircleItemIds={duplicateCircleItemIds} highlightedItemId={highlightedItemId} layoutMode={layoutMode}
        />
      </div>
    </div>
  );
};

export default EditModeContent;
