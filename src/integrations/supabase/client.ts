import { createClient } from '@supabase/supabase-js';

const FALLBACK_URL = 'https://dmqiauxksjspxwtvdcdx.supabase.co';
const FALLBACK_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRtcWlhdXhrc2pzcHh3dHZkY2R4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMDc5OTAsImV4cCI6MjEwMzg4Mzk5MH0.NEhF7zRlaUMgGbhDY08y2WyMDSttd0G6xcytBA-SG6A';

/**
 * Normalises a Supabase project URL so it is strictly `https://<ref>.supabase.co`.
 * Strips trailing slashes and any accidental sub-paths such as `/auth/v1`, `/rest/v1`
 * or `/storage/v1` — these cause "Invalid path specified in request URL" errors.
 */
export function normalizeSupabaseUrl(raw: string | undefined | null): string {
  const value = (raw ?? '').trim();
  if (!value) return FALLBACK_URL;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value.replace(/\/(auth|rest|storage|realtime|functions)\/v\d+.*$/i, '').replace(/\/+$/, '');
  }
}

export const supabaseUrl = normalizeSupabaseUrl(import.meta.env['VITE_SUPABASE_URL']);
export const supabaseAnonKey: string =
  import.meta.env['VITE_SUPABASE_PUBLISHABLE_KEY'] || import.meta.env['VITE_SUPABASE_ANON_KEY'] || FALLBACK_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Public storage bucket + file that hold the HK Wallet logo. */
export const LOGO_BUCKET = 'logs';
export const LOGO_FILE = 'Hkwallet_logo.png';
export const logoUrl = `${supabaseUrl}/storage/v1/object/public/${LOGO_BUCKET}/${LOGO_FILE}`;

/** Local APK download path — never an external link. */
export const APK_DOWNLOAD_URL = '/hkwallet.apk';
