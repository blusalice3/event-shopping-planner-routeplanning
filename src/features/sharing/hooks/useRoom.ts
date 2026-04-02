import { useState, useCallback, useEffect } from 'react';
import { supabase } from '../config/supabase';
import type { ActiveRoom, RoomMember, StoredRoomInfo } from '../types/room';
import * as roomService from '../services/roomService';

const STORAGE_KEY = 'sharing:activeRoom';

interface UseRoomReturn {
  activeRoom: ActiveRoom | null;
  members: RoomMember[];
  isRoomLoading: boolean;
  roomError: string | null;
  createRoom: (eventName: string, displayName: string, expiresAt: string) => Promise<ActiveRoom>;
  joinRoom: (roomCode: string, displayName: string) => Promise<ActiveRoom>;
  rejoinRoom: (roomCode: string, displayName: string) => Promise<ActiveRoom>;
  leaveRoom: () => Promise<void>;
  refreshMembers: () => Promise<void>;
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

  // ページリロード時の自動再参加
  useEffect(() => {
    if (!supabase || !userId) return;

    const storedRoom = loadStoredRoom();
    if (!storedRoom) return;

    let mounted = true;
    setIsRoomLoading(true);

    roomService
      .rejoinRoom(supabase!, storedRoom.roomCode, userId, storedRoom.displayName)
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
        saveStoredRoom({ roomCode: room.roomCode, roomId: room.id, displayName });
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
        saveStoredRoom({ roomCode: room.roomCode, roomId: room.id, displayName });
        const m = await roomService.getRoomMembers(supabase, room.id);
        setMembers(m);
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
    async (roomCode: string, displayName: string): Promise<ActiveRoom> => {
      if (!supabase || !userId) throw new Error('認証が完了していません');
      setIsRoomLoading(true);
      setRoomError(null);
      try {
        const room = await roomService.rejoinRoom(supabase, roomCode, userId, displayName);
        setActiveRoom(room);
        saveStoredRoom({ roomCode: room.roomCode, roomId: room.id, displayName });
        const m = await roomService.getRoomMembers(supabase, room.id);
        setMembers(m);
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

  return {
    activeRoom,
    members,
    isRoomLoading,
    roomError,
    createRoom,
    joinRoom,
    rejoinRoom: rejoinRoomAction,
    leaveRoom: leaveRoomAction,
    refreshMembers,
  };
}
