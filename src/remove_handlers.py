#!/usr/bin/env python3
"""Remove handler functions that have been extracted to hooks."""

with open('/home/claude/source/src/App.tsx', 'r') as f:
    content = f.read()

def remove_section(content, start_marker, end_marker, include_end=True):
    """Remove a section between start_marker and end_marker."""
    start_idx = content.find(start_marker)
    if start_idx == -1:
        print(f"  WARNING: Start marker not found: {start_marker[:60]}...")
        return content
    
    end_idx = content.find(end_marker, start_idx + len(start_marker))
    if end_idx == -1:
        print(f"  WARNING: End marker not found: {end_marker[:60]}...")
        return content
    
    if include_end:
        end_idx += len(end_marker)
    
    # Also remove trailing newlines
    while end_idx < len(content) and content[end_idx] == '\n':
        end_idx += 1
    
    removed = content[start_idx:end_idx]
    line_count = removed.count('\n')
    print(f"  Removed {line_count} lines: {start_marker[:50]}...")
    
    return content[:start_idx] + content[end_idx:]

# 1. Remove handleMoveItem
content = remove_section(content,
    "  const handleMoveItem = useCallback((dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate', sourceColumn?: 'execute' | 'candidate') => {",
    "  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates, selectedBlockFilters, items]);")

# 2. Remove handleMoveItemUp
content = remove_section(content,
    "  const handleMoveItemUp = useCallback((itemId: string, targetColumn?: 'execute' | 'candidate') => {",
    "  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates, areItemsInSameHall]);",
    include_end=True)

# 3. Remove handleMoveItemDown (note: starts without leading spaces due to original formatting)
content = remove_section(content,
    "const handleMoveItemDown = useCallback((itemId: string, targetColumn?: 'execute' | 'candidate') => {",
    "  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates, areItemsInSameHall]);")

# 4. Remove handleMoveToExecuteColumn
content = remove_section(content,
    "  const handleMoveToExecuteColumn = useCallback((itemIds: string[]) => {",
    "  }, [activeEventName, activeTab, eventDates, rangeStart, rangeEnd, items, executeModeItems, selectedBlockFilters]);")

# 5. Remove handleRemoveFromExecuteColumn
content = remove_section(content,
    "  const handleRemoveFromExecuteColumn = useCallback((itemIds: string[]) => {",
    "  }, [activeEventName, activeTab, eventDates, rangeStart, rangeEnd]);")

# 6. Remove handleSortToggle
content = remove_section(content,
    "  const handleSortToggle = () => {",
    "  };\n\n  const handleBlockSortToggle",
    include_end=False)

# 7. Remove handleBlockSortToggle
content = remove_section(content,
    "  const handleBlockSortToggle = () => {",
    "  };\n\n  const handleBlockSortToggleCandidate",
    include_end=False)

# 8. Remove handleBlockSortToggleCandidate
content = remove_section(content,
    "  const handleBlockSortToggleCandidate = () => {",
    "  };\n\n  const handleEditRequest",
    include_end=False)

# 9. Remove handleSelectItem
content = remove_section(content,
    "  const handleSelectItem = useCallback((itemId: string, columnType?: 'execute' | 'candidate') => {\n    setSortState('Manual');\n    setBlockSortDirection(null);",
    "  }, [activeTab, activeEventName, executeModeItems, eventDates, rangeStart, rangeEnd, items, selectedBlockFilters]);")

# 10. Remove handleToggleBlockFilter
content = remove_section(content,
    "  const handleToggleBlockFilter = useCallback((block: string) => {",
    "  }, []);\n\n  const handleClearBlockFilters",
    include_end=False)

# 11. Remove handleClearBlockFilters
content = remove_section(content,
    "  const handleClearBlockFilters = useCallback(() => {",
    "    setSelectedBlockFilters(new Set());\n  }, []);")

# 12. Remove candidateNumberSortDirection state + handleCandidateNumberSort
content = remove_section(content,
    "  const [candidateNumberSortDirection, setCandidateNumberSortDirection] = useState<'asc' | 'desc' | null>(null);\n\n  const handleCandidateNumberSort",
    "  }, [activeEventName, activeTab, executeModeItems, selectedBlockFilters, candidateNumberSortDirection, eventDates]);")

# 13. Remove handleClearSelection
content = remove_section(content,
    "  const handleClearSelection = useCallback(() => {\n    setSelectedItemIds(new Set());\n    setRangeStart(null);\n    setRangeEnd(null);\n  }, []);",
    "  }, []);")

# 14. Remove handleToggleRangeSelection
content = remove_section(content,
    "  // 範囲内のアイテムを一括でチェック/チェック解除する関数\n  const handleToggleRangeSelection",
    "  }, [rangeStart, rangeEnd, activeTab, activeEventName, eventDates, executeModeItems, items, selectedBlockFilters, getHallsForDate, getMapDataForDate]);")

# 15. Remove handleBulkSort
content = remove_section(content,
    "  const handleBulkSort = useCallback((direction: BulkSortDirection) => {",
    "  }, [activeEventName, selectedItemIds, items, activeTab, dayModes, executeModeItems, eventDates]);\n\n  // エクスポートオプションダイアログを表示",
    include_end=False)

# 16. Remove handleExportEvent
content = remove_section(content,
    "  // エクスポートオプションダイアログを表示\n  const handleExportEvent = useCallback((eventName: string) => {",
    "  }, [eventLists]);\n\n  // 実際のエクスポート処理（xlsx形式）",
    include_end=False)

# 17. Remove handleConfirmExport
content = remove_section(content,
    "  // 実際のエクスポート処理（xlsx形式）\n  const handleConfirmExport = useCallback(async (options: ExportOptions) => {",
    "  }, [eventLists, executeModeItems, eventMetadata, dayModes, mapData, routeSettings, hallDefinitions, hallRouteSettings, exportEventName]);")

# 18. Remove handleExportFileImport
content = remove_section(content,
    "  const handleExportFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {",
    "  }, [eventLists]);\n\n  // アイテム更新機能",
    include_end=False)

# 19. Remove handleImportMapData
content = remove_section(content,
    "  const handleImportMapData = useCallback(async (eventName: string) => {\n    if (mapFileInputRef.current) {",
    "  }, []);")

# 20. Remove handleMapFileChange
content = remove_section(content,
    "  const handleMapFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {\n    const file = e.target.files?.[0];\n    const eventName = e.target.dataset.eventName;",
    "  }, []);")

# 21. Remove handleMapImportConfirm
content = remove_section(content,
    "  // マップ取り込みダイアログからの取り込み確定\n  const handleMapImportConfirm",
    "  }, [mapImportPendingEventName]);")

# 22. Remove handleMapImportClose
content = remove_section(content,
    "  // マップ取り込みダイアログのキャンセル\n  const handleMapImportClose",
    "  }, []);\n\n  // マップビューでの訪問先追加",
    include_end=False)

with open('/home/claude/source/src/App.tsx', 'w') as f:
    f.write(content)

# Count remaining lines
line_count = content.count('\n') + 1
print(f"\nApp.tsx is now {line_count} lines")
