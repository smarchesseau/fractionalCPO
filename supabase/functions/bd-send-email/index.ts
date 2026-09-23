// The only code path allowed to call Brevo. Handles: connection test,
// test sends (never touch prospect/batch state), and real single-recipient
// sends (invoked once per recipient by the browser's batch-sending loop --
// there is no server-side batch loop, by design, since sending must stay
// manually paced and resumable).
import { preflight, json } from "../_shared/cors.ts";
import { requireOwner, serviceRoleClient } from "../_shared/auth.ts";
import { isValidEmail, plainTextToHtml } from "../_shared/bdLogic.ts";

const UNRESOLVED_VAR_RE = /\{\{\s*\w+\s*\}\}/;
const STAGE_SENT_FIELD: Record<string, string> = {
  initial: "initial_sent_at",
  followup1: "followup1_sent_at",
  followup2: "followup2_sent_at",
};
const STAGE_ACCEPTED_FIELD: Record<string, string> = {
  initial: "initial_accepted",
  followup1: "followup1_accepted",
  followup2: "followup2_accepted",
};
const STAGE_MESSAGE_ID_FIELD: Record<string, string> = {
  initial: "initial_message_id",
  followup1: "followup1_message_id",
  followup2: "followup2_message_id",
};
const STAGE_ERROR_FIELD: Record<string, string> = {
  initial: "initial_send_error",
  followup1: "followup1_send_error",
  followup2: "followup2_send_error",
};
const STAGE_STATUS: Record<string, string> = {
  initial: "initial_sent",
  followup1: "followup1_sent",
  followup2: "followup2_sent",
};
const EXCLUDED_SEND_STATUSES = ["bounced", "invalid_email", "do_not_contact"];

interface SendPayload {
  mode: "test_connection" | "test" | "send";
  prospect_id?: string;
  stage?: "initial" | "followup1" | "followup2";
  subject?: string;
  body?: string;
  batch_id?: string;
  batch_member_id?: string;
  test_recipient?: string;
  override_duplicate_stage?: boolean;
}

async function sendViaBrevo(opts: {
  apiKey: string;
  senderEmail: string;
  senderName: string;
  replyTo: string;
  toEmail: string;
  toName?: string;
  subject: string;
  body: string;
}): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": opts.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: opts.senderName, email: opts.senderEmail },
        replyTo: { email: opts.replyTo },
        to: [{ email: opts.toEmail, name: opts.toName || undefined }],
        subject: opts.subject,
        htmlContent: plainTextToHtml(opts.body),
        textContent: opts.body,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: `Brevo ${res.status}: ${data?.message ?? JSON.stringify(data)}` };
    }
    return { ok: true, messageId: data?.messageId ?? "" };
  } catch (e) {
    return { ok: false, error: `Network error calling Brevo: ${e instanceof Error ? e.message : String(e)}` };
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);

  const auth = await requireOwner(req);
  if (!auth.ok) return auth.response;

  let payload: SendPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, reason: "invalid_json" }, 400);
  }

  const brevoApiKey = Deno.env.get("BREVO_API_KEY") ?? "";
  const senderEmail = Deno.env.get("BREVO_SENDER_EMAIL") ?? "";
  const senderName = Deno.env.get("BREVO_SENDER_NAME") || "Stephanie Marchesseau";

  if (payload.mode === "test_connection") {
    if (!brevoApiKey) return json({ ok: true, connected: false, reason: "missing_api_key" });
    try {
      const res = await fetch("https://api.brevo.com/v3/account", {
        headers: { "api-key": brevoApiKey, Accept: "application/json" },
      });
      return json({ ok: true, connected: res.ok, sender_configured: !!senderEmail });
    } catch (e) {
      return json({ ok: true, connected: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const stage = payload.stage;
  const subject = (payload.subject ?? "").trim();
  const body = (payload.body ?? "").trim();

  if (!stage || !STAGE_SENT_FIELD[stage]) return json({ ok: false, reason: "invalid_stage" }, 400);
  if (!subject || !body) return json({ ok: false, reason: "empty_email" }, 400);
  if (UNRESOLVED_VAR_RE.test(subject) || UNRESOLVED_VAR_RE.test(body)) {
    return json({ ok: false, reason: "unresolved_variables" }, 400);
  }
  if (!brevoApiKey || !senderEmail) {
    return json({ ok: false, reason: "brevo_not_configured" }, 400);
  }

  const supabase = serviceRoleClient();

  // Reply-to is configurable from the Settings screen (bd_settings), unlike
  // sender identity which stays a deploy-time secret; BREVO_REPLY_TO_EMAIL
  // is only the fallback for a fresh deployment before Settings is saved.
  const { data: settingsForReplyTo } = await supabase.from("bd_settings").select("reply_to_email, default_test_recipient").single();
  const replyTo = settingsForReplyTo?.reply_to_email || Deno.env.get("BREVO_REPLY_TO_EMAIL") || senderEmail;

  if (payload.mode === "test") {
    const testRecipient = payload.test_recipient || settingsForReplyTo?.default_test_recipient;
    if (!testRecipient || !isValidEmail(testRecipient)) {
      return json({ ok: false, reason: "invalid_test_recipient" }, 400);
    }
    const result = await sendViaBrevo({
      apiKey: brevoApiKey,
      senderEmail,
      senderName,
      replyTo,
      toEmail: testRecipient,
      subject: `[TEST] ${subject}`,
      body,
    });
    await supabase.from("bd_activity").insert({
      action: "test_send",
      prospect_id: payload.prospect_id ?? null,
      batch_id: payload.batch_id ?? null,
      details: { to: testRecipient, ok: result.ok },
    });
    return json(result.ok ? { ok: true, message_id: result.messageId } : { ok: false, reason: "brevo_error", detail: result.error });
  }

  if (payload.mode !== "send") {
    return json({ ok: false, reason: "invalid_mode" }, 400);
  }

  if ((Deno.env.get("BD_REAL_EMAIL_SENDING_ENABLED") ?? "false").toLowerCase() !== "true") {
    return json({ ok: false, reason: "real_sending_disabled" }, 403);
  }
  if (!payload.prospect_id || !payload.batch_id || !payload.batch_member_id) {
    return json({ ok: false, reason: "missing_ids" }, 400);
  }

  const { data: prospect, error: prospectErr } = await supabase
    .from("bd_prospects")
    .select("*")
    .eq("id", payload.prospect_id)
    .single();
  if (prospectErr || !prospect) return json({ ok: false, reason: "prospect_not_found" }, 404);

  const ineligible: string[] = [];
  if (prospect.do_not_contact) ineligible.push("do_not_contact");
  if (EXCLUDED_SEND_STATUSES.includes(prospect.status)) ineligible.push(`status_${prospect.status}`);
  if (!isValidEmail(prospect.email)) ineligible.push("invalid_email_format");
  if (prospect[STAGE_SENT_FIELD[stage]] && !payload.override_duplicate_stage) ineligible.push("duplicate_stage");
  if (ineligible.length > 0) {
    return json({ ok: false, reason: "ineligible", ineligible_reasons: ineligible }, 409);
  }

  const { data: settingsRow } = await supabase.from("bd_settings").select("daily_send_limit").single();
  const dailyLimit = settingsRow?.daily_send_limit ?? 20;
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count: sentToday } = await supabase
    .from("bd_batch_members")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent")
    .gte("sent_at", startOfDay.toISOString());
  if ((sentToday ?? 0) >= dailyLimit) {
    return json({ ok: false, reason: "daily_limit_reached", limit: dailyLimit }, 429);
  }

  // Atomic claim: only the first request for this batch_member proceeds.
  const { data: claimed } = await supabase
    .from("bd_batch_members")
    .update({ attempted_at: new Date().toISOString() })
    .eq("id", payload.batch_member_id)
    .eq("batch_id", payload.batch_id)
    .eq("status", "pending")
    .is("attempted_at", null)
    .select("id")
    .single();
  if (!claimed) {
    return json({ ok: false, reason: "already_processing_or_sent" }, 409);
  }

  const result = await sendViaBrevo({
    apiKey: brevoApiKey,
    senderEmail,
    senderName,
    replyTo,
    toEmail: prospect.email,
    toName: prospect.contact_name || undefined,
    subject,
    body,
  });

  const nowIso = new Date().toISOString();

  if (!result.ok) {
    await supabase.from("bd_batch_members").update({ status: "failed", error: result.error }).eq("id", payload.batch_member_id);
    await supabase.from("bd_prospects").update({ [STAGE_ERROR_FIELD[stage]]: result.error }).eq("id", prospect.id);
    const { data: failedBatchRow } = await supabase.from("bd_batches").select("failure_count").eq("id", payload.batch_id).single();
    await supabase.from("bd_batches").update({ failure_count: (failedBatchRow?.failure_count ?? 0) + 1 }).eq("id", payload.batch_id);
    await supabase.from("bd_activity").insert({
      action: "send_failed",
      prospect_id: prospect.id,
      batch_id: payload.batch_id,
      details: { stage, error: result.error },
    });
    return json({ ok: false, reason: "brevo_error", detail: result.error });
  }

  await supabase.from("bd_batch_members").update({
    status: "sent",
    message_id: result.messageId,
    sent_at: nowIso,
  }).eq("id", payload.batch_member_id);

  await supabase.from("bd_prospects").update({
    [STAGE_SENT_FIELD[stage]]: nowIso,
    [STAGE_ACCEPTED_FIELD[stage]]: true,
    [STAGE_MESSAGE_ID_FIELD[stage]]: result.messageId,
    [STAGE_ERROR_FIELD[stage]]: null,
    status: STAGE_STATUS[stage],
    last_contacted_at: nowIso,
  }).eq("id", prospect.id);

  const { data: batchRow } = await supabase.from("bd_batches").select("success_count").eq("id", payload.batch_id).single();
  await supabase.from("bd_batches").update({ success_count: (batchRow?.success_count ?? 0) + 1 }).eq("id", payload.batch_id);

  await supabase.from("bd_activity").insert({
    action: "send",
    prospect_id: prospect.id,
    batch_id: payload.batch_id,
    details: { stage, message_id: result.messageId },
  });

  return json({ ok: true, message_id: result.messageId });
});
