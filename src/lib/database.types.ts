export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type MemberStatus = 'roaming' | 'inQueue' | 'done' | 'resting';

export type RoomItemPurchaseStatus =
  | 'None'
  | 'Purchased'
  | 'SoldOut'
  | 'Absent'
  | 'Postpone'
  | 'Late'
  | 'LimitedPurchase';

export interface Database {
  public: {
    Tables: {
      rooms: {
        Row: {
          id: string;
          room_code: string;
          event_name: string;
          created_by: string;
          created_at: string;
          expires_at: string;
          max_members: number;
          is_active: boolean;
        };
        Insert: {
          id?: string;
          room_code: string;
          event_name: string;
          created_by?: string;
          created_at?: string;
          expires_at: string;
          max_members?: number;
          is_active?: boolean;
        };
        Update: {
          id?: string;
          room_code?: string;
          event_name?: string;
          created_by?: string;
          created_at?: string;
          expires_at?: string;
          max_members?: number;
          is_active?: boolean;
        };
      };
      room_members: {
        Row: {
          id: string;
          room_id: string;
          user_id: string;
          display_name: string;
          color: string;
          joined_at: string;
          is_online: boolean;
          last_seen_at: string;
          status: MemberStatus;
          queue_circle_name: string | null;
          queue_started_at: string | null;
          current_hall_id: string | null;
          current_block: string | null;
          current_number: string | null;
          remaining_items: number;
        };
        Insert: {
          id?: string;
          room_id: string;
          user_id?: string;
          display_name: string;
          color?: string;
          joined_at?: string;
          is_online?: boolean;
          last_seen_at?: string;
          status?: MemberStatus;
          queue_circle_name?: string | null;
          queue_started_at?: string | null;
          current_hall_id?: string | null;
          current_block?: string | null;
          current_number?: string | null;
          remaining_items?: number;
        };
        Update: {
          id?: string;
          room_id?: string;
          user_id?: string;
          display_name?: string;
          color?: string;
          joined_at?: string;
          is_online?: boolean;
          last_seen_at?: string;
          status?: MemberStatus;
          queue_circle_name?: string | null;
          queue_started_at?: string | null;
          current_hall_id?: string | null;
          current_block?: string | null;
          current_number?: string | null;
          remaining_items?: number;
        };
      };
      room_items: {
        Row: {
          id: string;
          room_id: string;
          local_item_id: string;
          purchase_status: RoomItemPurchaseStatus;
          assigned_to: string | null;
          updated_by: string | null;
          updated_at: string;
          quantity: number;
          price: number | null;
          order_index: number;
          postponed: boolean;
          circle_name: string;
          event_date: string;
          block_name: string | null;
          booth_number: string | null;
          title: string | null;
        };
        Insert: {
          id?: string;
          room_id: string;
          local_item_id: string;
          purchase_status?: RoomItemPurchaseStatus;
          assigned_to?: string | null;
          updated_by?: string | null;
          updated_at?: string;
          quantity?: number;
          price?: number | null;
          order_index?: number;
          postponed?: boolean;
          circle_name: string;
          event_date: string;
          block_name?: string | null;
          booth_number?: string | null;
          title?: string | null;
        };
        Update: {
          id?: string;
          room_id?: string;
          local_item_id?: string;
          purchase_status?: RoomItemPurchaseStatus;
          assigned_to?: string | null;
          updated_by?: string | null;
          updated_at?: string;
          quantity?: number;
          price?: number | null;
          order_index?: number;
          postponed?: boolean;
          circle_name?: string;
          event_date?: string;
          block_name?: string | null;
          booth_number?: string | null;
          title?: string | null;
        };
      };
      notifications: {
        Row: {
          id: string;
          room_id: string;
          target_user_id: string | null;
          type: string;
          payload: Json;
          is_read: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          room_id: string;
          target_user_id?: string | null;
          type: string;
          payload?: Json;
          is_read?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          room_id?: string;
          target_user_id?: string | null;
          type?: string;
          payload?: Json;
          is_read?: boolean;
          created_at?: string;
        };
      };
      activity_log: {
        Row: {
          id: string;
          room_id: string;
          user_id: string;
          action: string;
          payload: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          room_id: string;
          user_id?: string;
          action: string;
          payload?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          room_id?: string;
          user_id?: string;
          action?: string;
          payload?: Json;
          created_at?: string;
        };
      };
    };
    Functions: {
      claim_item: {
        Args: {
          p_room_id: string;
          p_item_id: string;
          p_user_id: string;
          p_status: string;
        };
        Returns: Json;
      };
    };
  };
}
