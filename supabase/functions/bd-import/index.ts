// Validates, dedupes and (on confirm) commits CSV-imported prospects.
// Parsing/column-mapping happens client-side; this function is the
// authoritative, server-side validation + write path. Never sends email.
import { preflight, json } from "../_shared/cors.ts";
import { requireOwner, serviceRoleClient } from "../_shared/auth.ts";
import {
  isValidEmail,
  normalizeEmail,
  splitSubjectAndBody,
  defaultSubjectFor,
} from "../_shared/bdLogic.ts";

interface ImportRow {
  row_index: number;
  company?: string;
  contact_name?: string;
  email?: string;
  location?: string;
  employee_range?: string;
  size_confidence?: string;
  sector?: string;
  target_decision_maker?: string;
  priority?: string;
  email_verification?: string;
  source_url?: string;
  pain_points?: string;
  automation_opportunities?: string;
  initial_email_raw?: string;
  followup1_raw?: string;
  followup2_raw?: string;
  duplicate_action?: "skip" | "update";
}

const MAX_ROWS = 1000;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);

  const auth = await requireOwner(req);
  if (!auth.ok) return auth.response;

  let payload: { dry_run?: boolean; rows?: ImportRow[] };
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, reason: "invalid_json" }, 400);
  }

  const rows = payload.rows ?? [];
  const dryRun = payload.dry_run !== false;

  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ ok: false, reason: "no_rows" }, 400);
  }
  if (rows.length > MAX_ROWS) {
    return json({ ok: false, reason: "too_many_rows", max: MAX_ROWS }, 400);
  }

  const supabase = serviceRoleClient();

  const { data: existing, error: existingErr } = await supabase
    .from("bd_prospects")
    .select("id, email_normalized, company");
  if (existingErr) {
    return json({ ok: false, reason: "db_error", detail: existingErr.message }, 500);
  }
  const existingByEmail = new Map<string, { id: string; company: string }>();
  for (const row of existing ?? []) {
    existingByEmail.set(row.email_normalized, { id: row.id, company: row.company });
  }

  // Duplicate rows within the same file, checked as we go.
  const seenInFile = new Set<string>();

  const results: Record<string, unknown>[] = [];
  let created = 0, updated = 0, skipped = 0, invalid = 0;

  for (const row of rows) {
    const rowIndex = row.row_index;
    const errors: string[] = [];
    const warnings: string[] = [];

    const company = (row.company ?? "").trim();
    const emailRaw = (row.email ?? "").trim();
    const emailNormalized = normalizeEmail(emailRaw);
    const initialRaw = (row.initial_email_raw ?? "").trim();

    if (!company) errors.push("Company is required.");
    if (!emailRaw || !isValidEmail(emailRaw)) errors.push("A valid email address is required.");
    if (!initialRaw) errors.push("Initial email is required.");

    if (errors.length > 0) {
      invalid++;
      results.push({ row_index: rowIndex, status: "invalid", errors, warnings });
      continue;
    }

    if (seenInFile.has(emailNormalized)) {
      warnings.push("Duplicate email within this file; only the first occurrence will be used.");
      results.push({ row_index: rowIndex, status: "skipped_file_duplicate", errors, warnings });
      skipped++;
      continue;
    }
    seenInFile.add(emailNormalized);

    const initial = splitSubjectAndBody(initialRaw, defaultSubjectFor(company));
    const followup1 = row.followup1_raw?.trim()
      ? splitSubjectAndBody(row.followup1_raw, defaultSubjectFor(company))
      : null;
    const followup2 = row.followup2_raw?.trim()
      ? splitSubjectAndBody(row.followup2_raw, defaultSubjectFor(company))
      : null;

    const record = {
      company,
      contact_name: row.contact_name?.trim() || null,
      email: emailRaw,
      location: row.location?.trim() || null,
      employee_range: row.employee_range?.trim() || null,
      size_confidence: row.size_confidence?.trim() || null,
      sector: row.sector?.trim() || null,
      target_decision_maker: row.target_decision_maker?.trim() || null,
      priority: row.priority?.trim() || null,
      email_verification: row.email_verification?.trim() || null,
      source_url: row.source_url?.trim() || null,
      pain_points: row.pain_points?.trim() || null,
      automation_opportunities: row.automation_opportunities?.trim() || null,
      initial_subject: initial.subject,
      initial_body: initial.body,
      followup1_subject: followup1?.subject ?? null,
      followup1_body: followup1?.body ?? null,
      followup2_subject: followup2?.subject ?? null,
      followup2_body: followup2?.body ?? null,
    };

    const duplicate = existingByEmail.get(emailNormalized);

    if (duplicate) {
      if (dryRun) {
        results.push({
          row_index: rowIndex,
          status: "duplicate",
          errors,
          warnings: [`Email already exists for "${duplicate.company}".`],
          existing_id: duplicate.id,
          preview: record,
        });
        continue;
      }
      if (row.duplicate_action === "update") {
        const { error: updErr } = await supabase.from("bd_prospects").update(record).eq("id", duplicate.id);
        if (updErr) {
          invalid++;
          results.push({ row_index: rowIndex, status: "invalid", errors: [updErr.message], warnings });
          continue;
        }
        updated++;
        results.push({ row_index: rowIndex, status: "updated", id: duplicate.id, errors, warnings });
      } else {
        skipped++;
        results.push({ row_index: rowIndex, status: "skipped_duplicate", existing_id: duplicate.id, errors, warnings });
      }
      continue;
    }

    if (dryRun) {
      results.push({ row_index: rowIndex, status: "will_create", errors, warnings, preview: record });
      continue;
    }

    const { data: inserted, error: insErr } = await supabase
      .from("bd_prospects")
      .insert({ ...record, status: "new" })
      .select("id")
      .single();
    if (insErr) {
      invalid++;
      results.push({ row_index: rowIndex, status: "invalid", errors: [insErr.message], warnings });
      continue;
    }
    created++;
    existingByEmail.set(emailNormalized, { id: inserted.id, company });
    results.push({ row_index: rowIndex, status: "created", id: inserted.id, errors, warnings });
  }

  if (!dryRun) {
    await supabase.from("bd_activity").insert({
      action: "import",
      details: { created, updated, skipped, invalid, total: rows.length },
    });
  }

  return json({ ok: true, dry_run: dryRun, summary: { created, updated, skipped, invalid, total: rows.length }, results });
});
