import { useState, useCallback } from 'react';
import { supabase } from '../config/supabase';
import type { ActiveRoom } from '../types/room';
import * as assignmentService from '../services/assignmentService';

interface UseAssignmentReturn {
  myItemsOnly: boolean;
  toggleMyItemsFilter: () => void;
  assignItem: (localItemId: string, targetUserId: string | null) => Promise<void>;
  bulkAssignItems: (localItemIds: string[], targetUserId: string | null) => Promise<void>;
}

export function useAssignment(
  activeRoom: ActiveRoom | null,
  userId: string | null,
  addPendingWrite: (id: string) => void,
  removePendingWrite: (id: string, delay?: number) => void,
): UseAssignmentReturn {
  const [myItemsOnly, setMyItemsOnly] = useState(false);

  const toggleMyItemsFilter = useCallback(() => {
    setMyItemsOnly((prev) => !prev);
  }, []);

  const assignItemAction = useCallback(
    async (localItemId: string, targetUserId: string | null) => {
      if (!supabase || !activeRoom || !userId) return;

      addPendingWrite(localItemId);
      try {
        await assignmentService.assignItem(supabase, activeRoom.id, localItemId, targetUserId, userId);
        removePendingWrite(localItemId);
      } catch (err) {
        removePendingWrite(localItemId, 0);
        throw err;
      }
    },
    [activeRoom, userId, addPendingWrite, removePendingWrite],
  );

  const bulkAssignItemsAction = useCallback(
    async (localItemIds: string[], targetUserId: string | null) => {
      if (!supabase || !activeRoom || !userId) return;

      for (const id of localItemIds) {
        addPendingWrite(id);
      }
      try {
        await assignmentService.bulkAssignItems(supabase, activeRoom.id, localItemIds, targetUserId, userId);
        for (const id of localItemIds) {
          removePendingWrite(id);
        }
      } catch (err) {
        for (const id of localItemIds) {
          removePendingWrite(id, 0);
        }
        throw err;
      }
    },
    [activeRoom, userId, addPendingWrite, removePendingWrite],
  );

  return {
    myItemsOnly,
    toggleMyItemsFilter,
    assignItem: assignItemAction,
    bulkAssignItems: bulkAssignItemsAction,
  };
}
