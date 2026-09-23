// Public, client-safe Supabase project config (protected by RLS + Edge
// Function auth checks, not by secrecy). Reuses the same Supabase project
// as the Choup_Assist app; the bd_ tables and this CRM's Edge Functions are
// isolated from it by RLS (see supabase/migrations) and by function naming.
const SUPABASE_URL = "https://zfesbneifcjbzmgsgdsa.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmZXNibmVpZmNqYnptZ3NnZHNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2Njg5MTIsImV4cCI6MjEwNTI0NDkxMn0.ROQkKTOmDWIPIpqeUHKYEX9QC4VqxudQzpVuwzOXAG0";
const BD_FUNCTIONS_BASE = `${SUPABASE_URL}/functions/v1`;

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function bdCallFunction(name, body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    throw new Error('Not authenticated');
  }
  const res = await fetch(`${BD_FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, ...json };
}
