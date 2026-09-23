// Reports whether Brevo/sending is configured, without ever exposing the
// API key itself. Backs the Settings screen's status indicator.
import { preflight, json } from "../_shared/cors.ts";
import { requireOwner, serviceRoleClient } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const auth = await requireOwner(req);
  if (!auth.ok) return auth.response;

  const brevoConfigured = !!Deno.env.get("BREVO_API_KEY");
  const senderConfigured = !!Deno.env.get("BREVO_SENDER_EMAIL");
  const realSendingEnabled = (Deno.env.get("BD_REAL_EMAIL_SENDING_ENABLED") ?? "false").toLowerCase() === "true";

  const supabase = serviceRoleClient();
  const { data: settings } = await supabase.from("bd_settings").select("daily_send_limit").single();
  const dailyLimit = settings?.daily_send_limit ?? 20;

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count: sentToday } = await supabase
    .from("bd_batch_members")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent")
    .gte("sent_at", startOfDay.toISOString());

  return json({
    ok: true,
    brevo_configured: brevoConfigured,
    sender_configured: senderConfigured,
    real_sending_enabled: realSendingEnabled,
    daily_limit: dailyLimit,
    sent_today: sentToday ?? 0,
    remaining_today: Math.max(0, dailyLimit - (sentToday ?? 0)),
    daily_limit_reached: (sentToday ?? 0) >= dailyLimit,
  });
});
