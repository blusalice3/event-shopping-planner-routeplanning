import { useState, useEffect } from 'react';
import { supabase } from '../config/supabase';

interface UseSupabaseAuthReturn {
  userId: string | null;
  isAuthReady: boolean;
}

/**
 * Supabase Anonymous Auth管理フック。
 * マウント時にセッション確認→なければ匿名サインイン。
 * supabaseがnull（環境変数未設定）なら即座にready状態を返す。
 */
export function useSupabaseAuth(): UseSupabaseAuthReturn {
  const [userId, setUserId] = useState<string | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setIsAuthReady(true);
      return;
    }

    let mounted = true;

    const initAuth = async () => {
      try {
        const { data: { session } } = await supabase!.auth.getSession();

        if (session?.user) {
          if (mounted) {
            setUserId(session.user.id);
            setIsAuthReady(true);
          }
          return;
        }

        const { data, error } = await supabase!.auth.signInAnonymously();
        if (error) {
          console.error('Anonymous auth failed:', error.message);
          if (mounted) setIsAuthReady(true);
          return;
        }

        if (mounted && data.user) {
          setUserId(data.user.id);
          setIsAuthReady(true);
        }
      } catch (err) {
        console.error('Auth initialization error:', err);
        if (mounted) setIsAuthReady(true);
      }
    };

    initAuth();

    const { data: { subscription } } = supabase!.auth.onAuthStateChange((_event, session) => {
      if (mounted) {
        setUserId(session?.user?.id ?? null);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return { userId, isAuthReady };
}
