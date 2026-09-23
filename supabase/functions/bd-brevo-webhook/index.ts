// Optional Brevo webhook: records delivery/open/click/bounce events for
// visibility only. Never infers a reply -- reply status stays manual.
// No JWT (Brevo can't send one); protected instead by a shared secret in
// the URL query string, compared with a timing-safe equality check.
// Enable by setting `verify_jwt = false` for this function in config.toml
// (already set) and registering:
//   https://<project-ref>.functions.supabase.co/bd-brevo-webhook?secret=<BD_WEBHOOK_SECRET>
// in the Brevo dashboard.
import { json } from "../_shared/cors.ts";
import { serviceRoleClient } from "../_shared/auth.ts";
import { timingSafeEqual } from "../_shared/bdLogic.ts";

const MESSAGE_ID_FIELDS = ["initial_message_id", "followup1_message_id", "followup2_message_id"];
const BOUNCE_EVENTS = new Set(["hard_bounce", "blocked", "invalid_email"]);
const NEVER_OVERWRITE_STATUSES = new Set(["won", "closed", "do_not_contact"]);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret") ?? "";
  const expected = Deno.env.get("BD_WEBHOOK_SECRET") ?? "";
  if (!expected || !timingSafeEqual(secret, expected)) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);

  let events: Record<string, unknown>[];
  try {
    const payload = await req.json();
    events = Array.isArray(payload) ? payload : [payload];
  } catch {
    return json({ ok: false, reason: "invalid_json" }, 400);
  }

  const supabase = serviceRoleClient();

  for (const event of events) {
    const messageId = String(event["message-id"] ?? event["messageId"] ?? "");
    const eventType = String(event["event"] ?? "unknown");
    const eventAt = event["date"] ? new Date(String(event["date"])).toISOString() : new Date().toISOString();
    if (!messageId) continue;

    let prospect: Record<string, unknown> | null = null;
    for (const field of MESSAGE_ID_FIELDS) {
      const { data } = await supabase.from("bd_prospects").select("*").eq(field, messageId).maybeSingle();
      if (data) {
        prospect = data;
        break;
      }
    }

    await supabase.from("bd_email_events").upsert(
      {
        prospect_id: prospect?.id ?? null,
        message_id: messageId,
        event_type: eventType,
        event_at: eventAt,
        raw: event,
      },
      { onConflict: "message_id,event_type,event_at", ignoreDuplicates: true },
    );

    if (prospect && BOUNCE_EVENTS.has(eventType) && !NEVER_OVERWRITE_STATUSES.has(String(prospect.status))) {
      await supabase.from("bd_prospects").update({ status: "bounced" }).eq("id", prospect.id as string);
    }
  }

  return json({ ok: true, processed: events.length });
});
