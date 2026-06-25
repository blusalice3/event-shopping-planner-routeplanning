export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_log: {
        Row: {
          action: string
          auth_user_id: string | null
          created_at: string
          id: string
          metadata: Json
          room_id: string | null
          room_member_id: string | null
        }
        Insert: {
          action: string
          auth_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          room_id?: string | null
          room_member_id?: string | null
        }
        Update: {
          action?: string
          auth_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          room_id?: string | null
          room_member_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_room_member_id_fkey"
            columns: ["room_member_id"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_delivery_state: {
        Row: {
          created_at: string
          notification_id: string
          room_id: string
          room_member_id: string
        }
        Insert: {
          created_at?: string
          notification_id: string
          room_id: string
          room_member_id: string
        }
        Update: {
          created_at?: string
          notification_id?: string
          room_id?: string
          room_member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_delivery_state_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_delivery_state_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_delivery_state_room_member_id_fkey"
            columns: ["room_member_id"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_reads: {
        Row: {
          hidden_at: string | null
          notification_id: string
          read_at: string | null
          room_id: string
          room_member_id: string
          updated_at: string
        }
        Insert: {
          hidden_at?: string | null
          notification_id: string
          read_at?: string | null
          room_id: string
          room_member_id: string
          updated_at?: string
        }
        Update: {
          hidden_at?: string | null
          notification_id?: string
          read_at?: string | null
          room_id?: string
          room_member_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_reads_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_reads_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_reads_room_member_id_fkey"
            columns: ["room_member_id"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          event_id: string
          id: string
          idempotency_key: string
          notification_type: string
          payload: Json
          room_id: string
          target_member_id: string | null
        }
        Insert: {
          created_at?: string
          event_id?: string
          id?: string
          idempotency_key: string
          notification_type: string
          payload?: Json
          room_id: string
          target_member_id?: string | null
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          idempotency_key?: string
          notification_type?: string
          payload?: Json
          room_id?: string
          target_member_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_target_member_id_fkey"
            columns: ["target_member_id"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
        ]
      }
      room_event_data: {
        Row: {
          created_at: string
          event_data: Json
          event_data_size_bytes: number
          room_id: string
          schema_version: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          event_data: Json
          event_data_size_bytes: number
          room_id: string
          schema_version: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          event_data?: Json
          event_data_size_bytes?: number
          room_id?: string
          schema_version?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_event_data_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: true
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_item_change_log: {
        Row: {
          change_type: string
          changed_fields: string[]
          changed_values: Json
          created_at: string
          field_clocks: Json
          field_updated_at: Json
          id: string
          item_payload: Json | null
          items_version: number
          local_item_id: string
          notification_id: string | null
          room_id: string
          room_item_id: string
          updated_by: string | null
        }
        Insert: {
          change_type?: string
          changed_fields: string[]
          changed_values?: Json
          created_at?: string
          field_clocks?: Json
          field_updated_at?: Json
          id?: string
          item_payload?: Json | null
          items_version: number
          local_item_id: string
          notification_id?: string | null
          room_id: string
          room_item_id: string
          updated_by?: string | null
        }
        Update: {
          change_type?: string
          changed_fields?: string[]
          changed_values?: Json
          created_at?: string
          field_clocks?: Json
          field_updated_at?: Json
          id?: string
          item_payload?: Json | null
          items_version?: number
          local_item_id?: string
          notification_id?: string | null
          room_id?: string
          room_item_id?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "room_item_change_log_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_item_change_log_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_item_change_log_room_item_id_fkey"
            columns: ["room_item_id"]
            isOneToOne: false
            referencedRelation: "room_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_item_change_log_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
        ]
      }
      room_items: {
        Row: {
          actual_purchase_quantity: number | null
          assigned_to: string | null
          block_name: string
          booth_number: string
          circle_name: string
          created_at: string
          deleted_at: string | null
          deleted_by: string | null
          event_date: string | null
          field_clocks: Json
          id: string
          item_version: number
          limit_quantity: number | null
          local_item_id: string
          manual_hall_id: string | null
          name: string
          order_index: number | null
          postponed: boolean
          price: number | null
          priority_level: string
          protection_level: string | null
          purchase_status: string
          quantity: number | null
          remarks: string | null
          room_id: string
          secured_by: string | null
          source: string | null
          title: string
          updated_at: string
          updated_by: string | null
          url: string | null
        }
        Insert: {
          actual_purchase_quantity?: number | null
          assigned_to?: string | null
          block_name: string
          booth_number: string
          circle_name: string
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          event_date?: string | null
          field_clocks?: Json
          id?: string
          item_version?: number
          limit_quantity?: number | null
          local_item_id: string
          manual_hall_id?: string | null
          name: string
          order_index?: number | null
          postponed?: boolean
          price?: number | null
          priority_level?: string
          protection_level?: string | null
          purchase_status?: string
          quantity?: number | null
          remarks?: string | null
          room_id: string
          secured_by?: string | null
          source?: string | null
          title: string
          updated_at?: string
          updated_by?: string | null
          url?: string | null
        }
        Update: {
          actual_purchase_quantity?: number | null
          assigned_to?: string | null
          block_name?: string
          booth_number?: string
          circle_name?: string
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          event_date?: string | null
          field_clocks?: Json
          id?: string
          item_version?: number
          limit_quantity?: number | null
          local_item_id?: string
          manual_hall_id?: string | null
          name?: string
          order_index?: number | null
          postponed?: boolean
          price?: number | null
          priority_level?: string
          protection_level?: string | null
          purchase_status?: string
          quantity?: number | null
          remarks?: string | null
          room_id?: string
          secured_by?: string | null
          source?: string | null
          title?: string
          updated_at?: string
          updated_by?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "room_items_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_items_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_items_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_items_secured_by_fkey"
            columns: ["secured_by"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_items_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
        ]
      }
      room_member_sync_state: {
        Row: {
          created_at: string
          items_version: number
          last_processed_event_created_at: string | null
          last_processed_event_id: string | null
          last_snapshot_ack_at: string | null
          last_snapshot_receipt_id: string | null
          processed_event_ids: Json
          room_id: string
          room_member_id: string
          route_order_versions: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          items_version?: number
          last_processed_event_created_at?: string | null
          last_processed_event_id?: string | null
          last_snapshot_ack_at?: string | null
          last_snapshot_receipt_id?: string | null
          processed_event_ids?: Json
          room_id: string
          room_member_id: string
          route_order_versions?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          items_version?: number
          last_processed_event_created_at?: string | null
          last_processed_event_id?: string | null
          last_snapshot_ack_at?: string | null
          last_snapshot_receipt_id?: string | null
          processed_event_ids?: Json
          room_id?: string
          room_member_id?: string
          route_order_versions?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_member_sync_state_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_member_sync_state_room_member_id_fkey"
            columns: ["room_member_id"]
            isOneToOne: true
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
        ]
      }
      room_members: {
        Row: {
          accepted_contract_version: number | null
          color: string | null
          created_at: string
          display_name: string
          id: string
          joined_at: string
          last_seen_at: string | null
          left_at: string | null
          membership_status: string
          paused_at: string | null
          role: string
          room_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          accepted_contract_version?: number | null
          color?: string | null
          created_at?: string
          display_name: string
          id?: string
          joined_at?: string
          last_seen_at?: string | null
          left_at?: string | null
          membership_status?: string
          paused_at?: string | null
          role: string
          room_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          accepted_contract_version?: number | null
          color?: string | null
          created_at?: string
          display_name?: string
          id?: string
          joined_at?: string
          last_seen_at?: string | null
          left_at?: string | null
          membership_status?: string
          paused_at?: string | null
          role?: string
          room_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_members_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_route_order_versions: {
        Row: {
          event_date: string
          room_id: string
          updated_at: string
          updated_by: string | null
          version: number
        }
        Insert: {
          event_date: string
          room_id: string
          updated_at?: string
          updated_by?: string | null
          version?: number
        }
        Update: {
          event_date?: string
          room_id?: string
          updated_at?: string
          updated_by?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "room_route_order_versions_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_route_order_versions_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
        ]
      }
      rooms: {
        Row: {
          created_at: string
          created_by: string | null
          event_name: string
          expires_at: string
          host_member_id: string | null
          id: string
          items_version: number
          room_code_digest: string | null
          room_code_secret_version: number | null
          route_order_version: number | null
          sharing_status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          event_name: string
          expires_at?: string
          host_member_id?: string | null
          id?: string
          items_version?: number
          room_code_digest?: string | null
          room_code_secret_version?: number | null
          route_order_version?: number | null
          sharing_status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          event_name?: string
          expires_at?: string
          host_member_id?: string | null
          id?: string
          items_version?: number
          room_code_digest?: string | null
          room_code_secret_version?: number | null
          route_order_version?: number | null
          sharing_status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rooms_host_member_id_fkey"
            columns: ["host_member_id"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ack_room_route_order_versions: {
        Args: { p_room_id: string; p_route_order_versions: Json }
        Returns: Json
      }
      ack_room_snapshot_watermark: {
        Args: { p_room_id: string; p_snapshot_receipt_id: string }
        Returns: Json
      }
      ack_room_sync_progress: {
        Args: {
          p_items_version: number
          p_last_processed_event_created_at?: string
          p_last_processed_event_id?: string
          p_processed_event_ids?: Json
          p_room_id: string
        }
        Returns: Json
      }
      assign_item: {
        Args: {
          p_assigned_to: string
          p_local_item_id: string
          p_room_id: string
        }
        Returns: Json
      }
      bulk_assign_items: {
        Args: {
          p_assigned_to: string
          p_local_item_ids: string[]
          p_room_id: string
        }
        Returns: Json
      }
      bulk_update_room_items_with_purchase: {
        Args: { p_mutations: Json; p_room_id: string }
        Returns: Json
      }
      can_select_room_notification: {
        Args: { p_notification_id: string; p_room_id: string }
        Returns: boolean
      }
      can_select_room_sync_rows: {
        Args: { p_room_id: string }
        Returns: boolean
      }
      cleanup_expired_room_data: {
        Args: {
          p_limit?: number
          p_retention_hours?: number
          p_room_id?: string
        }
        Returns: Json
      }
      create_room: {
        Args: {
          p_challenge_id: string
          p_display_name: string
          p_member_restore_token: string
          p_room_id: string
        }
        Returns: Json
      }
      delete_room_item_with_route: {
        Args: {
          p_expected_field_clocks: Json
          p_local_item_id: string
          p_room_id: string
          p_route_updates: Json
        }
        Returns: Json
      }
      expire_room_for_cleanup: { Args: { p_room_id: string }; Returns: Json }
      get_notification_list: {
        Args: {
          p_include_hidden?: boolean
          p_limit?: number
          p_room_id: string
        }
        Returns: Json
      }
      get_notifications_after_watermark: {
        Args: {
          p_after_created_at?: string
          p_after_id?: string
          p_limit?: number
          p_room_id: string
        }
        Returns: Json
      }
      get_room_item_changes_since: {
        Args: { p_room_id: string; p_since_items_version: number }
        Returns: Json
      }
      get_room_members_for_display: {
        Args: { p_room_id: string }
        Returns: Json
      }
      get_room_snapshot: { Args: { p_room_id: string }; Returns: Json }
      get_room_versions: { Args: { p_room_id: string }; Returns: Json }
      get_route_order_by_date: {
        Args: { p_event_date: string; p_room_id: string }
        Returns: Json
      }
      guard_check_edge_rate_limit_internal: {
        Args: {
          p_auth_user_id: string
          p_device_hash?: string
          p_ip_hash?: string
          p_purpose: string
          p_session_hash?: string
        }
        Returns: Json
      }
      guard_prepare_create_room_internal: {
        Args: {
          p_auth_user_id: string
          p_canonical_payload: string
          p_canonical_schema_version: number
          p_client_room_id: string
          p_item_count: number
          p_payload_protection_mode?: string
          p_plaintext_fingerprint: string
        }
        Returns: Json
      }
      guard_prepare_join_internal: {
        Args: { p_auth_user_id: string; p_room_code: string }
        Returns: Json
      }
      guard_prepare_restore_internal: {
        Args: { p_auth_user_id: string; p_room_id: string }
        Returns: Json
      }
      heartbeat_room_session: { Args: { p_room_id: string }; Returns: Json }
      hide_notification: {
        Args: {
          p_is_hidden?: boolean
          p_notification_id: string
          p_room_id: string
        }
        Returns: Json
      }
      join_room_by_code: {
        Args: {
          p_challenge_id: string
          p_display_name: string
          p_member_restore_token: string
        }
        Returns: Json
      }
      leave_room: {
        Args: { p_mode?: string; p_room_id: string }
        Returns: Json
      }
      mark_notification_read: {
        Args: {
          p_is_read?: boolean
          p_notification_id: string
          p_room_id: string
        }
        Returns: Json
      }
      pause_room_session: { Args: { p_room_id: string }; Returns: Json }
      prepare_create_room_challenge: {
        Args: {
          p_canonical_payload: string
          p_canonical_schema_version: number
          p_client_room_id: string
          p_item_count: number
          p_payload_protection_mode?: string
          p_plaintext_fingerprint: string
        }
        Returns: Json
      }
      prepare_restore_member_token: {
        Args: { p_room_id: string }
        Returns: Json
      }
      prepare_room_member_token: {
        Args: { p_room_code: string }
        Returns: Json
      }
      restore_member_by_key: {
        Args: { p_challenge_id: string; p_member_restore_token: string }
        Returns: Json
      }
      update_room_item_with_purchase:
        | {
            Args: {
              p_actual_purchase_quantity?: number
              p_fields?: Json
              p_local_item_id: string
              p_room_id: string
              p_status?: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_actual_purchase_quantity: number
              p_expected_field_clocks: Json
              p_fields: Json
              p_local_item_id: string
              p_room_id: string
              p_status: string
            }
            Returns: Json
          }
      update_route_order: {
        Args: {
          p_event_date: string
          p_expected_version: number
          p_item_ids: string[]
          p_room_id: string
        }
        Returns: Json
      }
      upsert_room_item_with_route: {
        Args: {
          p_expected_field_clocks: Json
          p_fields: Json
          p_local_item_id: string
          p_room_id: string
          p_route_updates: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
