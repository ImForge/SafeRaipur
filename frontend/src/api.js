/**
 * Data layer v2 — talks straight to Supabase. No FastAPI, no Render,
 * nothing that can fall asleep.
 *
 * Reads:  incidents, user_reports, risk_cells, alerts, police_stations
 * Writes: submit_report() RPC only (validated + rate-limited in the DB)
 */
import { supabase } from './lib/supabase.js';

const DAYS_180 = new Date(Date.now() - 180 * 864e5).toISOString();

export const api = {
  /** News/seed incidents from the last 180 days (matches the KDE half-life window). */
  async listIncidents() {
    const { data, error } = await supabase
      .from('incidents')
      .select('id,type,severity,area,title,source,source_url,occurred_at,lat,lng')
      .gte('occurred_at', DAYS_180)
      .order('occurred_at', { ascending: false })
      .limit(2000);
    if (error) throw error;
    return data;
  },

  /** Community reports (moderation-hidden rows never leave the DB — RLS). */
  async listReports() {
    const { data, error } = await supabase
      .from('user_reports')
      .select('id,type,severity,time_of_day,area,occurred_at,lat,lng,is_verified,confirms,flags')
      .gte('occurred_at', DAYS_180)
      .order('occurred_at', { ascending: false })
      .limit(1000);
    if (error) throw error;
    return data;
  },

  /** Precomputed KDE grid — the ingestion job keeps this fresh. One query, instant map. */
  async getRiskCells(timeOfDay) {
    const { data, error } = await supabase
      .from('risk_cells')
      .select('lat,lng,score')
      .eq('time_of_day', timeOfDay)
      .limit(4000);
    if (error) throw error;
    return data;
  },

  /** Active surge alerts. */
  async listAlerts() {
    const { data, error } = await supabase
      .from('alerts')
      .select('id,lat,lng,radius_m,report_count,max_severity,area,created_at,expires_at')
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  async listStations() {
    const { data, error } = await supabase
      .from('police_stations').select('name,phone,lat,lng');
    if (error) throw error;
    return data;
  },

  /**
   * Submit an anonymous report through the DB-side RPC.
   * Severity is assigned server-side; the RPC also enforces the Raipur
   * bounding box and a 3-reports-per-hour-per-device limit.
   */
  /** Anonymous vote on a community report: 'confirm' or 'fake'. One vote per device per report (DB-enforced). */
  async voteReport(reportId, kind, anonymous_id) {
    const { data, error } = await supabase.rpc('vote_report', {
      p_report_id: reportId, p_kind: kind, p_anon_id: anonymous_id,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'Vote rejected');
    return data;
  },

  async submitReport({ type, lat, lng, time_of_day, anonymous_id }) {
    const { data, error } = await supabase.rpc('submit_report', {
      p_type: type, p_lat: lat, p_lng: lng,
      p_time_of_day: time_of_day, p_anon_id: anonymous_id,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'Report rejected');
    return data;
  },
};

/** Stable anonymous per-device id — hashed with a server salt before storage. */
export function getAnonymousId() {
  let id = localStorage.getItem('rsm_anon_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('rsm_anon_id', id);
  }
  return id;
}
