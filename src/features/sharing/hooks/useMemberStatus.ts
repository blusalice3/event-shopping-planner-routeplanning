import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '../config/supabase';
import type { ActiveRoom, RoomMember } from '../types/room';
import type { ShoppingItem } from '../../../types';
import * as memberStatusService from '../services/memberStatusService';

interface UseMemberStatusReturn {
  updateMyStatus: (status: memberStatusService.MemberStatus, queueCircleName?: string) => Promise<void>;
  requestHelp: (circleName: string) => Promise<void>;
  acceptHelp: (requesterId: string) => Promise<string[]>;
}

export function useMemberStatus(
  activeRoom: ActiveRoom | null,
  userId: string | null,
  members: RoomMember[],
  items: ShoppingItem[],
): UseMemberStatusReturn {
  const currentMember = members.find((m) => m.userId === userId);
  const remainingCountRef = useRef(0);

  // 自分の残アイテム数を自動計算（背番号ベース）
  const myJerseyStr = currentMember ? String(currentMember.jerseyNumber) : null;
  useEffect(() => {
    if (!myJerseyStr) return;
    const remaining = items.filter(
      (item) =>
        (item.assignedTo === myJerseyStr || !item.assignedTo) &&
        item.purchaseStatus === 'None',
    ).length;
    remainingCountRef.current = remaining;
  }, [items, myJerseyStr]);

  const updateMyStatus = useCallback(
    async (status: memberStatusService.MemberStatus, queueCircleName?: string) => {
      if (!supabase || !activeRoom || !userId) return;
      await memberStatusService.updateMemberStatus(supabase, activeRoom.id, userId, status, {
        queueCircleName,
        remainingItems: remainingCountRef.current,
      });
    },
    [activeRoom, userId],
  );

  const requestHelp = useCallback(
    async (circleName: string) => {
      if (!supabase || !activeRoom || !userId || !currentMember) return;
      await memberStatusService.requestHelp(
        supabase,
        activeRoom.id,
        userId,
        currentMember.displayName,
        circleName,
        remainingCountRef.current,
      );
    },
    [activeRoom, userId, currentMember],
  );

  const acceptHelp = useCallback(
    async (requesterId: string): Promise<string[]> => {
      if (!supabase || !activeRoom || !userId || !currentMember) return [];
      return memberStatusService.acceptHelp(
        supabase,
        activeRoom.id,
        userId,
        currentMember.displayName,
        requesterId,
      );
    },
    [activeRoom, userId, currentMember],
  );

  return { updateMyStatus, requestHelp, acceptHelp };
}
