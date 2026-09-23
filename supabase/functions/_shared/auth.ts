import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const OWNER_EMAIL = Deno.env.get("BD_OWNER_EMAIL") ?? "marchesseau.stephanie@gmail.com";

/**
 * Verifies the caller's JWT (forwarded from the browser) identifies the
 * single CRM owner. This is the real, server-side auth gate -- RLS backs it
 * up independently for every direct table read/write.
 */
export async function requireOwner(
  req: Request,
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error } = await authClient.auth.getUser();
  if (error || !user) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ ok: false, reason: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
  if ((user.email ?? "").toLowerCase() !== OWNER_EMAIL.toLowerCase()) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ ok: false, reason: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
  return { ok: true, userId: user.id };
}

export function serviceRoleClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}
