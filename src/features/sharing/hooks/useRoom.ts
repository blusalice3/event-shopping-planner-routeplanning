import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '../config/supabase';
import type { ActiveRoom, RoomMember, StoredRoomInfo } from '../types/room';
import * as roomService from '../services/roomService';
import { createNotification } from '../services/notificationService';

const STORAGE_KEY = 'sharing:activeRoom';
const REJOIN_APPROVAL_TIMEOUT_MS = 120_000; // 2分

/** 承認待ちの再参加リクエスト情報 */
export interface PendingRejoin {
  roomCode: string;
  displayName: string;
  jerseyNumber: number;
  targetDisplayName: string;
  roomId: string;
}

interface UseRoomReturn {
  activeRoom: ActiveRoom | null;
  members: RoomMember[];
  isRoomLoading: boolean;
  roomError: string | null;
  pendingRejoin: PendingRejoin | null;
  createRoom: (eventName: string, displayName: string, expiresAt: string) => Promise<ActiveRoom>;
  joinRoom: (roomCode: string, displayName: string) => Promise<ActiveRoom>;
  rejoinRoom: (roomCode: string, displayName: string, jerseyNumber?: number) => Promise<ActiveRoom>;
  requestRejoinWithApproval: (roomCode: string, displayName: string, jerseyNumber: number) => Promise<void>;
  cancelPendingRejoin: () => void;
  getRoomMembersForRejoin: (roomCode: string) => Promise<{ jerseyNumber: number; displayName: string }[]>;
  leaveRoom: () => Promise<void>;
  refreshMembers: () => Promise<void>;
  setActiveRoom: React.Dispatch<React.SetStateAction<ActiveRoom | null>>;
}

function loadStoredRoom(): StoredRoomInfo | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function saveStoredRoom(info: StoredRoomInfo): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
}

function clearStoredRoom(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function useRoom(userId: string | null): UseRoomReturn {
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [isRoomLoading, setIsRoomLoading] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [pendingRejoin, setPendingRejoin] = useState<PendingRejoin | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rejoinChannelRef = useRef<any>(null);

  // ページリロード時の自動再参加
  useEffect(() => {
    if (!supabase || !userId) return;

    const storedRoom = loadStoredRoom();
    if (!storedRoom) return;

    let mounted = true;
    setIsRoomLoading(true);

    roomService
      .rejoinRoom(supabase!, storedRoom.roomCode, userId, storedRoom.displayName, storedRoom.jerseyNumber)
      .then((room) => {
        if (mounted) {
          setActiveRoom(room);
          setRoomError(null);
        }
        return roomService.getRoomMembers(supabase!, room.id);
      })
      .then((m) => {
        if (mounted) setMembers(m);
      })
      .catch((err) => {
        if (mounted) {
          setRoomError(err instanceof Error ? err.message : '再参加に失敗しました');
          clearStoredRoom();
        }
      })
      .finally(() => {
        if (mounted) setIsRoomLoading(false);
      });

    return () => { mounted = false; };
  }, [userId]);

  const refreshMembers = useCallback(async () => {
    if (!supabase || !activeRoom) return;
    const m = await roomService.getRoomMembers(supabase, activeRoom.id);
    setMembers(m);
  }, [activeRoom]);

  const createRoom = useCallback(
    async (eventName: string, displayName: string, expiresAt: string): Promise<ActiveRoom> => {
      if (!supabase || !userId) throw new Error('認証が完了していません');
      setIsRoomLoading(true);
      setRoomError(null);
      try {
        const room = await roomService.createRoom(supabase, eventName, userId, displayName, expiresAt);
        setActiveRoom(room);
        // ホストは背番号#1
        saveStoredRoom({ roomCode: room.roomCode, roomId: room.id, displayName, jerseyNumber: 1 });
        const m = await roomService.getRoomMembers(supabase, room.id);
        setMembers(m);
        return room;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'ルーム作成に失敗しました';
        setRoomError(msg);
        throw err;
      } finally {
        setIsRoomLoading(false);
      }
    },
    [userId],
  );

  const joinRoom = useCallback(
    async (roomCode: string, displayName: string): Promise<ActiveRoom> => {
      if (!supabase || !userId) throw new Error('認証が完了していません');
      setIsRoomLoading(true);
      setRoomError(null);
      try {
        const room = await roomService.joinRoom(supabase, roomCode, userId, displayName);
        setActiveRoom(room);
        const m = await roomService.getRoomMembers(supabase, room.id);
        setMembers(m);
        // 参加後にメンバー一覧から自分の背番号を取得して保存
        const myMember = m.find((member) => member.userId === userId);
        saveStoredRoom({ roomCode: room.roomCode, roomId: room.id, displayName, jerseyNumber: myMember?.jerseyNumber });
        return room;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '参加に失敗しました';
        setRoomError(msg);
        throw err;
      } finally {
        setIsRoomLoading(false);
      }
    },
    [userId],
  );

  const rejoinRoomAction = useCallback(
    async (roomCode: string, displayName: string, jerseyNumber?: number): Promise<ActiveRoom> => {
      if (!supabase || !userId) throw new Error('認証が完了していません');
      setIsRoomLoading(true);
      setRoomError(null);
      try {
        const room = await roomService.rejoinRoom(supabase, roomCode, userId, displayName, jerseyNumber);
        setActiveRoom(room);
        const m = await roomService.getRoomMembers(supabase, room.id);
        setMembers(m);
        const myMember = m.find((member) => member.userId === userId);
        saveStoredRoom({ roomCode: room.roomCode, roomId: room.id, displayName, jerseyNumber: myMember?.jerseyNumber });
        return room;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '再参加に失敗しました';
        setRoomError(msg);
        throw err;
      } finally {
        setIsRoomLoading(false);
      }
    },
    [userId],
  );

  const leaveRoomAction = useCallback(async () => {
    if (!supabase || !userId || !activeRoom) return;
    setIsRoomLoading(true);
    try {
      await roomService.leaveRoom(supabase, activeRoom.id, userId);
      setActiveRoom(null);
      setMembers([]);
      clearStoredRoom();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '退出に失敗しました';
      setRoomError(msg);
      throw err;
    } finally {
      setIsRoomLoading(false);
    }
  }, [userId, activeRoom]);

  const getRoomMembersForRejoinAction = useCallback(
    async (roomCode: string) => {
      if (!supabase) return [];
      return roomService.getRoomMembersForRejoin(supabase, roomCode);
    },
    [],
  );

  // 承認付き再参加リクエスト
  const requestRejoinWithApproval = useCallback(
    async (roomCode: string, displayName: string, jerseyNumber: number) => {
      if (!supabase || !userId) throw new Error('認証が完了していません');
      setRoomError(null);

      try {
        const result = await roomService.requestRejoin(
          supabase, roomCode, userId, displayName, jerseyNumber,
        );

        // 承認不要ケース: 直接rejoin
        // requestRejoinがSELF_REJOINやHOST_SELF_REJOINをthrowするのでここには来ない
        // （catchで処理）

        // ホスト+副ホストに通知送信
        for (const approverUserId of result.approverUserIds) {
          await createNotification(supabase, result.roomId, 'rejoin_request', {
            requesterId: userId,
            requesterDisplayName: displayName,
            targetJerseyNumber: jerseyNumber,
            targetDisplayName: result.targetDisplayName,
          }, approverUserId);
        }

        // 承認待ちステートに移行
        setPendingRejoin({
          roomCode,
          displayName,
          jerseyNumber,
          targetDisplayName: result.targetDisplayName,
          roomId: result.roomId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        // 承認不要ケース: 直接rejoin
        if (msg === 'SELF_REJOIN' || msg === 'HOST_SELF_REJOIN') {
          await rejoinRoomAction(roomCode, displayName, jerseyNumber);
          return;
        }
        setRoomError(msg || '再参加リクエストに失敗しました');
        throw err;
      }
    },
    [userId],
  );

  const cancelPendingRejoin = useCallback(() => {
    setPendingRejoin(null);
    setRoomError(null);
  }, []);

  // 承認結果のリアルタイム監視
  useEffect(() => {
    if (!pendingRejoin || !supabase || !userId) return;

    const timeout = setTimeout(() => {
      setPendingRejoin(null);
      setRoomError('承認がタイムアウトしました。再度お試しください。');
    }, REJOIN_APPROVAL_TIMEOUT_MS);

    const channel = supabase
      .channel(`rejoin-watch:${userId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'notifications',
        filter: `target_user_id=eq.${userId}`,
      }, async (payload) => {
        const n = payload.new as Record<string, unknown>;
        if (n.type === 'rejoin_approved') {
          try {
            await rejoinRoomAction(
              pendingRejoin.roomCode,
              pendingRejoin.displayName,
              pendingRejoin.jerseyNumber,
            );
          } catch {
            setRoomError('再参加に失敗しました。');
          }
          setPendingRejoin(null);
        } else if (n.type === 'rejoin_rejected') {
          setRoomError('再参加が拒否されました。');
          setPendingRejoin(null);
        }
      }).subscribe();

    rejoinChannelRef.current = channel;

    return () => {
      clearTimeout(timeout);
      supabase!.removeChannel(channel);
      rejoinChannelRef.current = null;
    };
  }, [pendingRejoin, userId]);

  return {
    activeRoom,
    members,
    isRoomLoading,
    roomError,
    pendingRejoin,
    createRoom,
    joinRoom,
    rejoinRoom: rejoinRoomAction,
    requestRejoinWithApproval,
    cancelPendingRejoin,
    leaveRoom: leaveRoomAction,
    refreshMembers,
    getRoomMembersForRejoin: getRoomMembersForRejoinAction,
    setActiveRoom,
  };
}
