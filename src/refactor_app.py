#!/usr/bin/env python3
"""Comprehensive App.tsx refactoring: remove handlers, add hooks, update imports."""

with open('/home/claude/source/src/App.tsx', 'r') as f:
    lines = f.readlines()

print(f"Original: {len(lines)} lines")

# First, find all sections to remove by searching for exact line content
def find_line(pattern, start_from=0):
    """Find line number (0-indexed) containing the pattern."""
    for i in range(start_from, len(lines)):
        if pattern in lines[i]:
            return i
    return -1

def find_closing_deps(start_line, dep_text):
    """Find the }, [dep_text]); line after start_line."""
    for i in range(start_line, len(lines)):
        if dep_text in lines[i] and (lines[i].strip().startswith('}, [') or lines[i].strip().startswith('], [') or lines[i].strip() == '});'):
            return i
    # Try finding just the dep text in dependency arrays
    for i in range(start_line, len(lines)):
        if dep_text in lines[i]:
            return i
    return -1

# Identify all sections to remove (as [start, end] inclusive ranges)
sections_to_remove = []

# 1. handleMoveItem
start = find_line("const handleMoveItem = useCallback((dragId: string, hoverId: string")
end = find_line("selectedBlockFilters, items])", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleMoveItem: lines {start+1}-{end+1} ({end-start+1} lines)")

# 2. handleMoveItemUp
start = find_line("const handleMoveItemUp = useCallback((itemId: string, targetColumn")
end = find_line("eventDates, areItemsInSameHall])", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleMoveItemUp: lines {start+1}-{end+1} ({end-start+1} lines)")

# 3. handleMoveItemDown
start = find_line("const handleMoveItemDown = useCallback((itemId: string, targetColumn")
end = find_line("eventDates, areItemsInSameHall])", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleMoveItemDown: lines {start+1}-{end+1} ({end-start+1} lines)")

# 4. handleMoveToExecuteColumn
start = find_line("const handleMoveToExecuteColumn = useCallback((itemIds: string[])")
end = find_line("items, executeModeItems, selectedBlockFilters])", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleMoveToExecuteColumn: lines {start+1}-{end+1} ({end-start+1} lines)")

# 5. handleRemoveFromExecuteColumn
start = find_line("const handleRemoveFromExecuteColumn = useCallback((itemIds: string[])")
end = find_line("eventDates, rangeStart, rangeEnd])", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleRemoveFromExecuteColumn: lines {start+1}-{end+1} ({end-start+1} lines)")

# 6. handleSortToggle + handleBlockSortToggle + handleBlockSortToggleCandidate
start = find_line("const handleSortToggle = () => {")
end = find_line("const handleEditRequest = (item: ShoppingItem)", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end - 1))  # Don't include handleEditRequest
    print(f"  Sort toggles: lines {start+1}-{end} ({end-start} lines)")

# 7. handleSelectItem (the old one with setSortState, setBlockSortDirection)
start = find_line("const handleSelectItem = useCallback((itemId: string, columnType")
end = find_line("rangeStart, rangeEnd, items, selectedBlockFilters])", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleSelectItem: lines {start+1}-{end+1} ({end-start+1} lines)")

# 8. handleToggleBlockFilter
start = find_line("const handleToggleBlockFilter = useCallback((block: string)")
end = find_line("}, []);", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleToggleBlockFilter: lines {start+1}-{end+1} ({end-start+1} lines)")

# 9. handleClearBlockFilters
start = find_line("const handleClearBlockFilters = useCallback(() => {")
end = find_line("}, []);", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleClearBlockFilters: lines {start+1}-{end+1} ({end-start+1} lines)")

# 10. candidateNumberSortDirection + handleCandidateNumberSort
start = find_line("const [candidateNumberSortDirection, setCandidateNumberSortDirection]")
end = find_line("candidateNumberSortDirection, eventDates])", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  candidateNumberSortDirection + handleCandidateNumberSort: lines {start+1}-{end+1} ({end-start+1} lines)")

# 11. handleClearSelection (be very specific!)
start = find_line("const handleClearSelection = useCallback(() => {")
# Find exactly the next 4 lines
if start >= 0:
    end = start + 4  # Should be: setSelected..., setRangeStart..., setRangeEnd..., }, []);
    # Verify
    if "}, []);" in lines[end]:
        sections_to_remove.append((start, end))
        print(f"  handleClearSelection: lines {start+1}-{end+1} ({end-start+1} lines)")
    else:
        print(f"  WARNING: handleClearSelection end not as expected at line {end+1}: {lines[end].strip()}")

# 12. handleToggleRangeSelection
start = find_line("const handleToggleRangeSelection = useCallback((columnType")
if start < 0:
    start = find_line("handleToggleRangeSelection = useCallback")
end = find_line("getHallsForDate, getMapDataForDate])", start)
if start >= 0 and end >= 0:
    # Include the comment line above if present
    if start > 0 and "範囲内のアイテムを一括" in lines[start - 1]:
        start -= 1
    sections_to_remove.append((start, end))
    print(f"  handleToggleRangeSelection: lines {start+1}-{end+1} ({end-start+1} lines)")

# 13. handleBulkSort
start = find_line("const handleBulkSort = useCallback((direction: BulkSortDirection)")
end = find_line("items, activeTab, dayModes, executeModeItems, eventDates])", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleBulkSort: lines {start+1}-{end+1} ({end-start+1} lines)")

# 14. handleExportEvent
start = find_line("const handleExportEvent = useCallback((eventName: string)")
if start > 0 and "エクスポートオプションダイアログ" in lines[start - 1]:
    start -= 1
end = find_line("}, [eventLists]);", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleExportEvent: lines {start+1}-{end+1} ({end-start+1} lines)")

# 15. handleConfirmExport
start = find_line("const handleConfirmExport = useCallback(async (options: ExportOptions)")
if start > 0 and "実際のエクスポート処理" in lines[start - 1]:
    start -= 1
end = find_line("hallRouteSettings, exportEventName])", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleConfirmExport: lines {start+1}-{end+1} ({end-start+1} lines)")

# 16. handleExportFileImport
start = find_line("const handleExportFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>)")
end = find_line("}, [eventLists]);", start)
if start >= 0 and end >= 0:
    # Skip past the next comment line if present
    while end + 1 < len(lines) and lines[end + 1].strip() == '':
        end += 1
    sections_to_remove.append((start, end))
    print(f"  handleExportFileImport: lines {start+1}-{end+1} ({end-start+1} lines)")

# 17. handleImportMapData
start = find_line("const handleImportMapData = useCallback(async (eventName: string)")
end = find_line("}, []);", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleImportMapData: lines {start+1}-{end+1} ({end-start+1} lines)")

# 18. handleMapFileChange
start = find_line("const handleMapFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>)")
end = find_line("}, []);", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleMapFileChange: lines {start+1}-{end+1} ({end-start+1} lines)")

# 19. handleMapImportConfirm
start = find_line("const handleMapImportConfirm = useCallback((parsedData")
if start > 0 and "マップ取り込みダイアログからの取り込み確定" in lines[start - 1]:
    start -= 1
end = find_line("}, [mapImportPendingEventName]);", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleMapImportConfirm: lines {start+1}-{end+1} ({end-start+1} lines)")

# 20. handleMapImportClose
start = find_line("const handleMapImportClose = useCallback(() => {")
if start > 0 and "マップ取り込みダイアログのキャンセル" in lines[start - 1]:
    start -= 1
end = find_line("}, []);", start)
if start >= 0 and end >= 0:
    sections_to_remove.append((start, end))
    print(f"  handleMapImportClose: lines {start+1}-{end+1} ({end-start+1} lines)")

# Sort sections in reverse order to remove from bottom up (preserve line numbers)
sections_to_remove.sort(key=lambda x: x[0], reverse=True)

print(f"\nRemoving {len(sections_to_remove)} sections...")

for start, end in sections_to_remove:
    del lines[start:end+1]

# Now also remove state declarations and update imports
content = ''.join(lines)

# Update imports
content = content.replace(
    "import { useMapControls } from './hooks/useMapControls';",
    """import { useMapControls } from './hooks/useMapControls';
import { useItemSelection } from './hooks/useItemSelection';
import { useSorting, sortCycle } from './hooks/useSorting';
import type { SortState } from './hooks/useSorting';
import { useExportImport } from './hooks/useExportImport';
import { useItemMovement } from './hooks/useItemMovement';"""
)

# Remove old type declarations
content = content.replace("type SortState = 'Manual' | 'Postpone' | 'Late' | 'Absent' | 'SoldOut' | 'None' | 'Purchased';\n", "")
content = content.replace("const sortCycle: SortState[] = ['Manual', 'Postpone', 'Late', 'Absent', 'SoldOut', 'None', 'Purchased'];\n", "")
content = content.replace("type BlockSortDirection = 'asc' | 'desc';\n", "")

# Remove exportToXlsx import
content = content.replace("import { exportToXlsx, importFromXlsx, downloadBlob } from './utils/exportImport';\n", "")

# Remove state declarations
content = content.replace(
    """  const [sortState, setSortState] = useState<SortState>('Manual');
  const [blockSortDirection, setBlockSortDirection] = useState<BlockSortDirection | null>(null);""",
    ""
)

content = content.replace(
    """  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [selectedBlockFilters, setSelectedBlockFilters] = useState<Set<string>>(new Set());
  const [recentlyChangedItemIds, setRecentlyChangedItemIds] = useState<Set<string>>(new Set());
  // 起点と終点を管理（列タイプとアイテムIDのペア）
  const [rangeStart, setRangeStart] = useState<{ itemId: string; columnType: 'execute' | 'candidate' } | null>(null);
  const [rangeEnd, setRangeEnd] = useState<{ itemId: string; columnType: 'execute' | 'candidate' } | null>(null);""",
    ""
)

content = content.replace(
    """  const [showExportOptions, setShowExportOptions] = useState(false);
  const [exportEventName, setExportEventName] = useState<string | null>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const exportFileInputRef = useRef<HTMLInputElement>(null);
  
  // マップ取り込みダイアログ用の状態
  const [mapImportDialogOpen, setMapImportDialogOpen] = useState(false);
  const [mapImportPendingFile, setMapImportPendingFile] = useState<File | null>(null);
  const [mapImportPendingEventName, setMapImportPendingEventName] = useState<string>('');""",
    ""
)

# Add hook calls after useUIVisibility
content = content.replace(
    """  } = useUIVisibility(activeEventName, currentMode, layoutMode, focusModeMapVisible);

  const handleBulkAdd""",
    """  } = useUIVisibility(activeEventName, currentMode, layoutMode, focusModeMapVisible);

  // アイテム選択 - extracted to useItemSelection hook
  const {
    selectedItemIds, setSelectedItemIds,
    selectedBlockFilters, setSelectedBlockFilters,
    recentlyChangedItemIds, setRecentlyChangedItemIds,
    rangeStart, setRangeStart,
    rangeEnd, setRangeEnd,
    handleSelectItem: handleSelectItemRaw,
    handleToggleBlockFilter,
    handleClearBlockFilters,
    handleClearSelection,
    handleToggleRangeSelection,
  } = useItemSelection({
    items, activeEventName, activeTab, eventDates, executeModeItems,
    getHallsForDate, getMapDataForDate,
  });

  // ソート - extracted to useSorting hook
  const {
    sortState, setSortState,
    blockSortDirection, setBlockSortDirection,
    candidateNumberSortDirection, setCandidateNumberSortDirection,
    handleSortToggle,
    handleBlockSortToggle,
    handleBlockSortToggleCandidate,
    handleCandidateNumberSort,
    handleBulkSort,
    resetSort,
  } = useSorting({
    activeEventName, activeTab, eventDates, items, executeModeItems, dayModes,
    selectedItemIds, selectedBlockFilters,
    setEventLists, setExecuteModeItems,
    resetSelection: handleClearSelection,
    resetRecentlyChanged: () => setRecentlyChangedItemIds(new Set()),
  });

  // handleSelectItemをラップしてソートリセットを追加
  const handleSelectItem = useCallback((itemId: string, columnType?: 'execute' | 'candidate') => {
    resetSort();
    handleSelectItemRaw(itemId, columnType);
  }, [resetSort, handleSelectItemRaw]);

  // エクスポート/インポート - extracted to useExportImport hook
  const {
    showExportOptions, setShowExportOptions,
    exportEventName,
    mapImportDialogOpen,
    mapImportPendingFile,
    mapImportPendingEventName,
    mapFileInputRef,
    exportFileInputRef,
    handleExportEvent,
    handleConfirmExport,
    handleExportFileImport,
    handleImportMapData,
    handleMapFileChange,
    handleMapImportConfirm,
    handleMapImportClose,
  } = useExportImport({
    eventLists, eventMetadata, executeModeItems, dayModes,
    mapData, routeSettings, hallDefinitions, hallRouteSettings,
    setEventLists, setEventMetadata, setExecuteModeItems, setDayModes,
    setMapData, setRouteSettings, setHallDefinitions, setHallRouteSettings,
    setActiveEventName, setActiveTab,
  });

  // アイテム移動 - extracted to useItemMovement hook
  const {
    handleMoveItem,
    handleMoveItemUp,
    handleMoveItemDown,
    handleMoveToExecuteColumn,
    handleRemoveFromExecuteColumn,
  } = useItemMovement({
    activeEventName, activeTab, eventDates, dayModes, executeModeItems, items,
    selectedItemIds, selectedBlockFilters, rangeStart, rangeEnd,
    areItemsInSameHall,
    setEventLists, setExecuteModeItems, setSelectedItemIds, setRangeStart, setRangeEnd,
    resetSort,
  });

  const handleBulkAdd"""
)

with open('/home/claude/source/src/App.tsx', 'w') as f:
    f.write(content)

final_count = content.count('\n') + 1
print(f"\nFinal App.tsx: {final_count} lines")
