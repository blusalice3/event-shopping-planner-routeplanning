
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ShoppingItem, PurchaseStatus } from './types';
import ImportScreen from './components/ImportScreen';
import ShoppingList from './components/ShoppingList';
import SummaryBar from './components/SummaryBar';
import EventListScreen from './components/EventListScreen';
import DeleteConfirmationModal from './components/DeleteConfirmationModal';
import ZoomControl from './components/ZoomControl';
import BulkActionControls from './components/BulkActionControls';
import SortAscendingIcon from './components/icons/SortAscendingIcon';
import SortDescendingIcon from './components/icons/SortDescendingIcon';

type ActiveTab = 'eventList' | 'day1' | 'day2' | 'import';
type SortState = 'Manual' | 'Postpone' | 'Late' | 'Absent' | 'SoldOut' | 'Purchased';
export type BulkSortDirection = 'asc' | 'desc';
type BlockSortDirection = 'asc' | 'desc';


const sortCycle: SortState[] = ['Postpone', 'Late', 'Absent', 'SoldOut', 'Purchased', 'Manual'];
const sortLabels: Record<SortState, string> = {
    Manual: '巡回順',
    Postpone: '単品後回し',
    Late: '遅参',
    Absent: '欠席',
    SoldOut: '売切',
    Purchased: '購入済',
};


const App: React.FC = () => {
  const [eventLists, setEventLists] = useState<Record<string, ShoppingItem[]>>({});
  const [activeEventName, setActiveEventName] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('eventList');
  const [sortState, setSortState] = useState<SortState>('Manual');
  const [blockSortDirection, setBlockSortDirection] = useState<BlockSortDirection | null>(null);
  const [itemToEdit, setItemToEdit] = useState<ShoppingItem | null>(null);
  const [itemToDelete, setItemToDelete] = useState<ShoppingItem | null>(null);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const storedLists = localStorage.getItem('eventShoppingLists');
      if (storedLists) {
        setEventLists(JSON.parse(storedLists));
      } else {
        // Simple migration from old format
        const oldStoredItems = localStorage.getItem('shoppingListItems');
        if (oldStoredItems) {
            const parsedItems = JSON.parse(oldStoredItems).map((item: any) => ({
                ...item,
                remarks: item.remarks || '',
            }));
            if (parsedItems.length > 0) {
                const defaultEventName = `インポート済リスト (${new Date().toLocaleDateString()})`;
                setEventLists({ [defaultEventName]: parsedItems });
                localStorage.removeItem('shoppingListItems'); // remove old key
            }
        }
      }
    } catch (error) {
      console.error("Failed to load items from localStorage", error);
    }
    setIsInitialized(true);
  }, []);

  useEffect(() => {
    if (isInitialized) {
      try {
        localStorage.setItem('eventShoppingLists', JSON.stringify(eventLists));
      } catch (error) {
        console.error("Failed to save items to localStorage", error);
      }
    }
  }, [eventLists, isInitialized]);

  const items = useMemo(() => activeEventName ? eventLists[activeEventName] || [] : [], [activeEventName, eventLists]);

  const handleBulkAdd = useCallback((eventName: string, newItemsData: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[]) => {
    const newItems: ShoppingItem[] = newItemsData.map(itemData => ({
        id: crypto.randomUUID(),
        ...itemData,
        purchaseStatus: 'None',
    }));

    const isNewEvent = !eventLists[eventName];

    setEventLists(prevLists => {
        const currentItems = prevLists[eventName] || [];
        return {
            ...prevLists,
            [eventName]: [...currentItems, ...newItems]
        };
    });

    alert(`${newItems.length}件のアイテムが${isNewEvent ? 'リストにインポートされました。' : '追加されました。'}`);
    
    if (isNewEvent) {
        setActiveEventName(eventName);
    }
    
    if (newItems.length > 0) {
        if (newItems.some(item => item.eventDate.includes('1日目'))) {
            setActiveTab('day1');
        } else if (newItems.some(item => item.eventDate.includes('2日目'))) {
            setActiveTab('day2');
        } else {
            setActiveTab('day1'); // Default fallback
        }
    }
  }, [eventLists]);

  const handleUpdateItem = useCallback((updatedItem: ShoppingItem) => {
    if (!activeEventName) return;
    setEventLists(prev => ({
      ...prev,
      [activeEventName]: prev[activeEventName].map(item => (item.id === updatedItem.id ? updatedItem : item))
    }));
  }, [activeEventName]);

  const handleMoveItem = useCallback((dragId: string, hoverId: string) => {
    if (!activeEventName) return;
    setSortState('Manual');
    setBlockSortDirection(null);

    // If the dragged item is part of a selection, move the whole selection
    if (selectedItemIds.has(dragId)) {
        setEventLists(prev => {
            const currentItems = [...(prev[activeEventName] || [])];
            
            // 1. Extract the selected items as a block, preserving their relative order.
            const selectedBlock = currentItems.filter(item => selectedItemIds.has(item.id));
            
            // 2. Create a list without the selected items.
            const listWithoutSelection = currentItems.filter(item => !selectedItemIds.has(item.id));
            
            // 3. Find the index of the drop target in the list without the selection.
            const targetIndex = listWithoutSelection.findIndex(item => item.id === hoverId);
            if (targetIndex === -1) return prev; // Should not happen if hoverId is not selected

            // 4. Splice the selected block into the list at the target index.
            listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);

            return { ...prev, [activeEventName]: listWithoutSelection };
        });
    } else {
        // Standard single-item move
        setEventLists(prev => {
            const newItems = [...(prev[activeEventName] || [])];
            const dragIndex = newItems.findIndex(item => item.id === dragId);
            const hoverIndex = newItems.findIndex(item => item.id === hoverId);
            
            if (dragIndex === -1 || hoverIndex === -1) return prev;

            const [draggedItem] = newItems.splice(dragIndex, 1);
            newItems.splice(hoverIndex, 0, draggedItem);
            return { ...prev, [activeEventName]: newItems };
        });
    }
  }, [activeEventName, selectedItemIds]);
  
  const handleSelectEvent = useCallback((eventName: string) => {
    setActiveEventName(eventName);
    setSelectedItemIds(new Set()); // Clear selection when changing events
    const eventItems = eventLists[eventName] || [];
    if (eventItems.some(item => item.eventDate.includes('1日目'))){
        setActiveTab('day1');
    } else if (eventItems.some(item => item.eventDate.includes('2日目'))) {
        setActiveTab('day2');
    } else {
        setActiveTab('day1');
    }
  }, [eventLists]);

  const handleDeleteEvent = useCallback((eventName: string) => {
    setEventLists(prev => {
        const newLists = {...prev};
        delete newLists[eventName];
        return newLists;
    });
    if (activeEventName === eventName) {
        setActiveEventName(null);
        setActiveTab('eventList');
    }
  }, [activeEventName]);

  const handleSortToggle = () => {
    setSelectedItemIds(new Set());
    setBlockSortDirection(null);
    const currentIndex = sortCycle.indexOf(sortState);
    const nextIndex = (currentIndex + 1) % sortCycle.length;
    setSortState(sortCycle[nextIndex]);
  };

  const handleBlockSortToggle = () => {
    if (!activeEventName) return;

    const nextDirection = blockSortDirection === 'asc' ? 'desc' : 'asc';

    setEventLists(prev => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = activeTab === 'day1' ? '1日目' : '2日目';

      const itemsForTab = allItems.filter(item => item.eventDate.includes(currentTabKey));
      
      if (itemsForTab.length === 0) return prev;

      const sortedItemsForTab = [...itemsForTab].sort((a, b) => {
        if (!a.block && !b.block) return 0;
        if (!a.block) return 1;
        if (!b.block) return -1;
        const comparison = a.block.localeCompare(b.block, 'ja', { numeric: true, sensitivity: 'base' });
        return nextDirection === 'asc' ? comparison : -comparison;
      });

      let sortedIndex = 0;
      const newItems = allItems.map(item => {
          if (item.eventDate.includes(currentTabKey)) {
              return sortedItemsForTab[sortedIndex++];
          }
          return item;
      });

      return { ...prev, [activeEventName]: newItems };
    });

    setBlockSortDirection(nextDirection);
    setSortState('Manual');
    setSelectedItemIds(new Set());
  };

  const handleEditRequest = (item: ShoppingItem) => {
    setItemToEdit(item);
    setActiveTab('import');
  };

  const handleDeleteRequest = (item: ShoppingItem) => {
    setItemToDelete(item);
  };

  const handleConfirmDelete = () => {
    if (!itemToDelete || !activeEventName) return;
    setEventLists(prev => ({
      ...prev,
      [activeEventName]: prev[activeEventName].filter(item => item.id !== itemToDelete.id)
    }));
    setItemToDelete(null);
  };

  const handleDoneEditing = () => {
    const originalDay = itemToEdit?.eventDate.includes('1日目') ? 'day1' : 'day2';
    setItemToEdit(null);
    setActiveTab(originalDay);
  };

  const handleSelectItem = useCallback((itemId: string) => {
    setSortState('Manual');
    setBlockSortDirection(null);
    setSelectedItemIds(prev => {
        const newSet = new Set(prev);
        if (newSet.has(itemId)) {
            newSet.delete(itemId);
        } else {
            newSet.add(itemId);
        }
        return newSet;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedItemIds(new Set());
  }, []);

  const handleBulkSort = useCallback((direction: BulkSortDirection) => {
    if (!activeEventName || selectedItemIds.size === 0) return;
    setSortState('Manual');
    setBlockSortDirection(null);

    setEventLists(prev => {
        const currentItems = [...(prev[activeEventName] || [])];
        const selectedItems = currentItems.filter(item => selectedItemIds.has(item.id));
        const otherItems = currentItems.filter(item => !selectedItemIds.has(item.id));

        selectedItems.sort((a, b) => {
            const comparison = a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: 'base' });
            return direction === 'asc' ? comparison : -comparison;
        });
        
        const firstSelectedIndex = currentItems.findIndex(item => selectedItemIds.has(item.id));
        if (firstSelectedIndex === -1) return prev;

        const newItems = [...otherItems];
        newItems.splice(firstSelectedIndex, 0, ...selectedItems);

        return { ...prev, [activeEventName]: newItems };
    });
}, [activeEventName, selectedItemIds]);

  const handleExportEvent = useCallback((eventName: string) => {
    const itemsToExport = eventLists[eventName];
    if (!itemsToExport || itemsToExport.length === 0) {
      alert('エクスポートするアイテムがありません。');
      return;
    }

    const statusLabels: Record<PurchaseStatus, string> = {
      None: '未購入',
      Purchased: '購入済',
      SoldOut: '売切',
      Absent: '欠席',
      Postpone: '後回し',
      Late: '遅参',
    };

    const escapeCsvCell = (cellData: string | number) => {
      const stringData = String(cellData);
      if (stringData.includes(',') || stringData.includes('"') || stringData.includes('\n')) {
        return `"${stringData.replace(/"/g, '""')}"`;
      }
      return stringData;
    };

    const headers = ['サークル名', '参加日', 'ブロック', 'ナンバー', 'タイトル', '頒布価格', '購入状態', '備考'];
    const csvRows = [headers.join(',')];

    itemsToExport.forEach(item => {
      const row = [
        escapeCsvCell(item.circle),
        escapeCsvCell(item.eventDate),
        escapeCsvCell(item.block),
        escapeCsvCell(item.number),
        escapeCsvCell(item.title),
        escapeCsvCell(item.price),
        escapeCsvCell(statusLabels[item.purchaseStatus] || item.purchaseStatus),
        escapeCsvCell(item.remarks),
      ];
      csvRows.push(row.join(','));
    });

    const csvString = csvRows.join('\n');
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]); // UTF-8 BOM for Excel
    const blob = new Blob([bom, csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `${eventName}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [eventLists]);
  
  const day1Items = useMemo(() => items.filter(item => item.eventDate.includes('1日目')), [items]);
  const day2Items = useMemo(() => items.filter(item => item.eventDate.includes('2日目')), [items]);

  const TabButton: React.FC<{tab: ActiveTab, label: string, count?: number, onClick?: () => void}> = ({ tab, label, count, onClick }) => (
      <button
        onClick={onClick || (() => { setItemToEdit(null); setSelectedItemIds(new Set()); setActiveTab(tab); })}
        className={`px-4 py-2 text-sm font-medium rounded-md transition-colors duration-200 whitespace-nowrap ${
          activeTab === tab
            ? 'bg-blue-600 text-white'
            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
        }`}
      >
        {label} {typeof count !== 'undefined' && <span className="text-xs bg-slate-200 dark:bg-slate-700 rounded-full px-2 py-0.5 ml-1">{count}</span>}
      </button>
  );

  const visibleItems = useMemo(() => {
    const itemsForTab = activeTab === 'day1' ? day1Items : day2Items;
    if (sortState === 'Manual') {
      return itemsForTab;
    }
    return itemsForTab.filter(item => item.purchaseStatus === sortState as Exclude<SortState, 'Manual'>);
  }, [activeTab, day1Items, day2Items, sortState]);
  
  if (!isInitialized) {
    return null; // or a loading spinner
  }

  const hasEventLists = Object.keys(eventLists).length > 0;
  const mainContentVisible = activeTab === 'day1' || activeTab === 'day2';
  
  const handleZoomChange = (newZoom: number) => {
    setZoomLevel(Math.max(50, Math.min(150, newZoom)));
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 dark:bg-slate-900 dark:text-slate-200 font-sans">
      <header className="bg-white dark:bg-slate-800 shadow-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto py-4 px-4 sm:px-6 lg:px-8 flex justify-between items-center">
          <div>
            <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-slate-900 dark:text-white">即売会 購入巡回表</h1>
                {activeEventName && mainContentVisible && items.length > 0 && (
                  <button
                    onClick={handleBlockSortToggle}
                    className={`p-2 rounded-md transition-colors duration-200 ${
                      blockSortDirection
                        ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
                        : 'bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400'
                    }`}
                    title={blockSortDirection === 'desc' ? "ブロック降順 (昇順へ)" : blockSortDirection === 'asc' ? "ブロック昇順 (降順へ)" : "ブロック昇順でソート"}
                  >
                    {blockSortDirection === 'desc' ? <SortDescendingIcon className="w-5 h-5" /> : <SortAscendingIcon className="w-5 h-5" />}
                  </button>
                )}
            </div>
            {activeEventName && <h2 className="text-sm text-blue-600 dark:text-blue-400 font-semibold mt-1">{activeEventName}</h2>}
          </div>
          {activeEventName && mainContentVisible && items.length > 0 && (
                <div className="flex items-center gap-4">
                    {selectedItemIds.size > 0 && (
                        <BulkActionControls
                            onSort={handleBulkSort}
                            onClear={handleClearSelection}
                        />
                    )}
                    <button
                        onClick={handleSortToggle}
                        className="px-3 py-1.5 text-sm font-medium rounded-md transition-colors duration-200 text-blue-600 bg-blue-100 hover:bg-blue-200 dark:text-blue-300 dark:bg-blue-900/50 dark:hover:bg-blue-900 flex-shrink-0"
                    >
                        {sortLabels[sortState]}
                    </button>
                </div>
            )}
        </div>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 border-t border-slate-200 dark:border-slate-700">
             <div className="flex space-x-2 pt-2 pb-2 overflow-x-auto">
                <TabButton tab="eventList" label="即売会リスト" onClick={() => { setActiveEventName(null); setItemToEdit(null); setSelectedItemIds(new Set()); setActiveTab('eventList'); }}/>
                {activeEventName ? (
                    <>
                        <TabButton tab="day1" label="1日目" count={day1Items.length} />
                        <TabButton tab="day2" label="2日目" count={day2Items.length} />
                        <TabButton tab="import" label={itemToEdit ? "アイテム編集" : "アイテム追加"} />
                    </>
                ) : (
                    <button
                        onClick={() => { setItemToEdit(null); setActiveTab('import'); }}
                        className={`px-4 py-2 text-sm font-medium rounded-md transition-colors duration-200 whitespace-nowrap ${
                            activeTab === 'import'
                            ? 'bg-blue-600 text-white'
                            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                        }`}
                    >
                        新規リスト作成
                    </button>
                )}
            </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8">
        {activeTab === 'eventList' && (
            <EventListScreen 
                eventNames={Object.keys(eventLists).sort()}
                onSelect={handleSelectEvent}
                onDelete={handleDeleteEvent}
                onExport={handleExportEvent}
            />
        )}
        {activeTab === 'import' && (
           <ImportScreen
             onBulkAdd={handleBulkAdd}
             activeEventName={activeEventName}
             itemToEdit={itemToEdit}
             onUpdateItem={handleUpdateItem}
             onDoneEditing={handleDoneEditing}
           />
        )}
        {activeEventName && mainContentVisible && (
          <div style={{
              transform: `scale(${zoomLevel / 100})`,
              transformOrigin: 'top left',
              width: `${100 * (100 / zoomLevel)}%`
          }}>
            <ShoppingList
                items={visibleItems}
                onUpdateItem={handleUpdateItem}
                onMoveItem={handleMoveItem}
                onEditRequest={handleEditRequest}
                onDeleteRequest={handleDeleteRequest}
                selectedItemIds={selectedItemIds}
                onSelectItem={handleSelectItem}
            />
          </div>
        )}
      </main>
      
      {itemToDelete && (
          <DeleteConfirmationModal
              item={itemToDelete}
              onConfirm={handleConfirmDelete}
              onCancel={() => setItemToDelete(null)}
          />
      )}

      {activeEventName && items.length > 0 && mainContentVisible && (
        <>
          <SummaryBar items={visibleItems} />
          <ZoomControl zoomLevel={zoomLevel} onZoomChange={handleZoomChange} />
        </>
      )}
    </div>
  );
};

export default App;
