/// <reference types="vite/client" />
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const sharingPublicGateEnabled =
  import.meta.env.VITE_SHARING_PUBLIC_GATE_ENABLED === 'true';
const sharingEdgeGuardUrl = import.meta.env.VITE_SHARING_EDGE_GUARD_URL as
  | string
  | undefined;

export const supabase: SupabaseClient<Database> | null =
  supabaseUrl && supabaseAnonKey
    ? createClient<Database>(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
        },
        realtime: {
          params: {
            eventsPerSecond: 10,
          },
        },
      })
    : null;

export type SharingAvailability =
  | { enabled: true; mode: 'local_or_limited' | 'public_guard' }
  | {
      enabled: false;
      reason:
        | 'SUPABASE_UNCONFIGURED'
        | 'PUBLIC_GUARD_UNCONFIGURED';
    };

export const getSharingAvailability = (): SharingAvailability => {
  if (!supabase) {
    return { enabled: false, reason: 'SUPABASE_UNCONFIGURED' };
  }

  if (sharingPublicGateEnabled) {
    return sharingEdgeGuardUrl
      ? { enabled: true, mode: 'public_guard' }
      : { enabled: false, reason: 'PUBLIC_GUARD_UNCONFIGURED' };
  }

  return { enabled: true, mode: 'local_or_limited' };
};

export const isSharingEnabled = (): boolean => getSharingAvailability().enabled;

export const getSharingPublicGuardBaseUrl = (): string | null => {
  const trimmed = sharingEdgeGuardUrl?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : null;
};
