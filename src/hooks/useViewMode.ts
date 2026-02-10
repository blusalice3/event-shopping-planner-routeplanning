import { useCallback } from 'react';
import { ViewMode, DayModeState } from '../types';

interface UseViewModeParams {
  activeEventName: string | null;
  activeTab: string;
  eventDates: string[];
  dayModes: Record<string, DayModeState>;
  setDayModes: React.Dispatch<React.SetStateAction<Record<string, DayModeState>>>;
  setSelectedItemIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setCandidateNumberSortDirection: React.Dispatch<React.SetStateAction<'asc' | 'desc' | null>>;
  setFocusModeMapVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setUiVisibilityOverride: React.Dispatch<React.SetStateAction<boolean>>;
  setUiSettingsPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useViewMode({
  activeEventName, activeTab, eventDates, dayModes,
  setDayModes, setSelectedItemIds, setCandidateNumberSortDirection,
  setFocusModeMapVisible, setUiVisibilityOverride, setUiSettingsPanelOpen,
}: UseViewModeParams) {

  const handleToggleMode = useCallback(() => {
    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const currentModeValue = dayModes[activeEventName]?.[currentEventDate] || 'edit';
    const newMode: ViewMode = currentModeValue === 'edit' ? 'execute' : 'edit';
    
    setDayModes(prev => ({
      ...prev,
      [activeEventName]: {
        ...(prev[activeEventName] || {}),
        [currentEventDate]: newMode
      }
    }));
    
    setSelectedItemIds(new Set());
    setCandidateNumberSortDirection(null);
  }, [activeEventName, activeTab, dayModes, eventDates, setDayModes, setSelectedItemIds, setCandidateNumberSortDirection]);
  
  const handleSetViewMode = useCallback((mode: ViewMode, scrollToItemId?: string) => {
    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    
    setDayModes(prev => ({
      ...prev,
      [activeEventName]: {
        ...(prev[activeEventName] || {}),
        [currentEventDate]: mode
      }
    }));
    
    setSelectedItemIds(new Set());
    setCandidateNumberSortDirection(null);
    
    if (mode !== 'focus') {
      setFocusModeMapVisible(false);
    }
    setUiVisibilityOverride(false);
    setUiSettingsPanelOpen(false);
    
    if (scrollToItemId) {
      setTimeout(() => {
        const element = document.querySelector(`[data-item-id="${scrollToItemId}"]`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);
    }
  }, [activeEventName, activeTab, eventDates, setDayModes, setSelectedItemIds, setCandidateNumberSortDirection, setFocusModeMapVisible, setUiVisibilityOverride, setUiSettingsPanelOpen]);

  return {
    handleToggleMode,
    handleSetViewMode,
  };
}
