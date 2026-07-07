/**
 * Supabase client — the ONLY backend connection SafeRaipur has now.
 *
 * The anon key is safe to ship in the browser: Row Level Security decides
 * what it can do (read public tables, call submit_report(), nothing else).
 * The service key lives ONLY in GitHub Actions secrets — never here.
 *
 * .env (local) / Vercel env vars (production):
 *   VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
 *   VITE_SUPABASE_ANON_KEY=eyJ...
 */
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && key ? createClient(url, key) : null;

export const supabaseConfigured = Boolean(supabase);
