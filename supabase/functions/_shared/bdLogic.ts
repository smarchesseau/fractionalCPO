// Pure, dependency-free helpers shared by the bd- Edge Functions.
// Kept side-effect-free so it can be unit tested without a live Supabase
// project (mirrors the _shared/salesLogic.ts pattern from the Sea View
// Yoga BD CRM).

export const BD_TEMPLATE_VARS = [
  "company",
  "contact_name",
  "location",
  "sector",
  "pain_points",
  "automation_opportunities",
] as const;

export type BdTemplateVars = Record<string, string | null | undefined>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  return EMAIL_RE.test(trimmed);
}

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

const SUBJECT_MARKER_RE = /(?:^|\n)[ \t]*(?:Subject|Asunto|Objet)[ \t]*:[ \t]*(.+?)[ \t]*\r?\n+/i;

/**
 * Splits a CSV cell that packs "Subject: ..." (or the Spanish "Asunto:" /
 * French "Objet:") on its own line, anywhere near the top, followed by the
 * body, e.g.:
 *   Subject: One workflow idea for Acme
 *
 *   Hello,
 *   ...
 * Falls back to `defaultSubject` when no such line is present, and treats
 * the whole cell as the body in that case.
 */
export function splitSubjectAndBody(
  cellText: string | null | undefined,
  defaultSubject: string,
): { subject: string; body: string } {
  const text = (cellText ?? "").replace(/\r\n/g, "\n");
  const match = text.match(SUBJECT_MARKER_RE);
  if (match) {
    const body = (text.slice(0, match.index) + text.slice((match.index ?? 0) + match[0].length)).trim();
    return { subject: match[1].trim(), body };
  }
  return { subject: defaultSubject, body: text.trim() };
}

/**
 * Finds a "Subject:"/"Asunto:"/"Objet:" line already embedded inside a body
 * that was imported before splitSubjectAndBody recognized it (e.g. non-
 * English markers), and extracts it. Returns null when no such line is
 * found. Used by the one-off "repair embedded subjects" data-cleanup tool,
 * not by fresh imports (those go through splitSubjectAndBody above).
 */
export function extractEmbeddedSubject(
  bodyText: string | null | undefined,
): { subject: string; body: string } | null {
  const text = (bodyText ?? "").replace(/\r\n/g, "\n");
  const match = text.match(SUBJECT_MARKER_RE);
  if (!match) return null;
  const body = (text.slice(0, match.index) + text.slice((match.index ?? 0) + match[0].length)).trim();
  return { subject: match[1].trim(), body };
}

export function defaultSubjectFor(company: string): string {
  return `One workflow idea for ${company}`;
}

export function greetingFor(contactName: string | null | undefined): string {
  const name = (contactName ?? "").trim();
  return name ? `Hello ${name},` : "Hello,";
}

/**
 * Renders {{var}} placeholders. Any variable that resolves to an empty
 * string is reported in `missing` so callers can block sending until every
 * variable is resolved.
 */
export function renderTemplate(
  templateStr: string | null | undefined,
  ctx: BdTemplateVars,
): { rendered: string; missing: string[] } {
  const missing: string[] = [];
  const rendered = (templateStr ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    const value = ctx[key];
    if (value === undefined || value === null || String(value).trim() === "") {
      missing.push(key);
      return "";
    }
    return String(value);
  });
  return { rendered, missing: [...new Set(missing)] };
}

export function buildTemplateContext(prospect: {
  company: string;
  contact_name?: string | null;
  location?: string | null;
  sector?: string | null;
  pain_points?: string | null;
  automation_opportunities?: string | null;
}): BdTemplateVars {
  return {
    company: prospect.company ?? "",
    contact_name: prospect.contact_name ?? "",
    location: prospect.location ?? "",
    sector: prospect.sector ?? "",
    pain_points: prospect.pain_points ?? "",
    automation_opportunities: prospect.automation_opportunities ?? "",
  };
}

export function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export const FOLLOW_UP_EXCLUDED_STATUSES = [
  "replied",
  "interested",
  "meeting_booked",
  "proposal_sent",
  "won",
  "not_interested",
  "do_not_contact",
  "closed",
  "bounced",
  "invalid_email",
] as const;

export function isFollowUpExcludedStatus(status: string): boolean {
  return (FOLLOW_UP_EXCLUDED_STATUSES as readonly string[]).includes(status);
}

export interface ProspectForEligibility {
  status: string;
  do_not_contact: boolean;
  initial_accepted: boolean;
  followup1_accepted: boolean;
  followup1_sent_at: string | null;
  followup2_sent_at: string | null;
  followup1_body: string | null;
  followup2_body: string | null;
}

export function isEligibleForFollowUp1(p: ProspectForEligibility): boolean {
  return (
    p.initial_accepted === true &&
    !p.followup1_sent_at &&
    !!(p.followup1_body && p.followup1_body.trim() !== "") &&
    p.do_not_contact === false &&
    !isFollowUpExcludedStatus(p.status)
  );
}

export function isEligibleForFollowUp2(p: ProspectForEligibility): boolean {
  return (
    p.followup1_accepted === true &&
    !p.followup2_sent_at &&
    !!(p.followup2_body && p.followup2_body.trim() !== "") &&
    p.do_not_contact === false &&
    !isFollowUpExcludedStatus(p.status)
  );
}

export const EMAIL_STAGE_SENT_FIELD: Record<string, "initial_sent_at" | "followup1_sent_at" | "followup2_sent_at"> = {
  initial: "initial_sent_at",
  followup1: "followup1_sent_at",
  followup2: "followup2_sent_at",
};

/** Case/whitespace-tolerant duplicate check used by CSV import. */
export function findDuplicateIndex(
  emailNormalized: string,
  existingEmails: Set<string>,
): boolean {
  return existingEmails.has(emailNormalized);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

export function accentSafeCsvBom(): string {
  // UTF-8 BOM so Excel opens exported CSVs with accented characters intact.
  return "﻿";
}
