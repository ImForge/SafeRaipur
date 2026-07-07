/**
 * Realtime — the heartbeat of SafeRaipur v2.
 *
 * Two websocket subscriptions via Supabase Realtime:
 *   INSERT on user_reports → someone just reported something, anywhere in
 *     the city → their pin appears on YOUR open map within a second.
 *   INSERT on alerts → the pg_cron surge detector found a cluster →
 *     every open map shows the pulsing surge ring + banner, live.
 *
 * No polling. No server. The database itself pushes the events.
 */
import { useEffect } from 'react';
import { supabase } from '../lib/supabase.js';

export function useRealtime({ onNewReport, onNewAlert }) {
  useEffect(() => {
    if (!supabase) return;

    const channel = supabase
      .channel('saferaipur-live')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'user_reports' },
        (payload) => onNewReport?.(payload.new))
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'alerts' },
        (payload) => onNewAlert?.(payload.new))
      .subscribe();

    return () => { supabase.removeChannel(channel); };
    // handlers are stable refs from App — subscribe once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
