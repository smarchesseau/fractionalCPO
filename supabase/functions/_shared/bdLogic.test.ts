import { assertEquals, assert } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  isValidEmail,
  normalizeEmail,
  splitSubjectAndBody,
  defaultSubjectFor,
  greetingFor,
  renderTemplate,
  buildTemplateContext,
  isFollowUpExcludedStatus,
  isEligibleForFollowUp1,
  isEligibleForFollowUp2,
  timingSafeEqual,
  extractEmbeddedSubject,
  ProspectForEligibility,
} from "./bdLogic.ts";

// --- email validation ---
Deno.test("isValidEmail accepts well-formed addresses", () => {
  assert(isValidEmail("jane@acme.com"));
  assert(isValidEmail("j.doe+bd@sub.acme.co.uk"));
});
Deno.test("isValidEmail rejects malformed or missing addresses", () => {
  assert(!isValidEmail(""));
  assert(!isValidEmail(null));
  assert(!isValidEmail(undefined));
  assert(!isValidEmail("not-an-email"));
  assert(!isValidEmail("missing@domain"));
  assert(!isValidEmail("@nolocal.com"));
});

Deno.test("normalizeEmail lowercases and trims", () => {
  assertEquals(normalizeEmail("  Jane@ACME.com "), "jane@acme.com");
});

// --- duplicate detection uses normalized email equality ---
Deno.test("duplicate detection is case/whitespace insensitive", () => {
  assertEquals(normalizeEmail("Jane@Acme.com"), normalizeEmail(" jane@acme.com "));
});

// --- subject/body parsing ---
Deno.test("splitSubjectAndBody extracts a leading Subject: line", () => {
  const cell = "Subject: One workflow idea for Acme\n\nHello,\n\nBody text here.";
  const { subject, body } = splitSubjectAndBody(cell, "fallback");
  assertEquals(subject, "One workflow idea for Acme");
  assertEquals(body, "Hello,\n\nBody text here.");
});
Deno.test("splitSubjectAndBody falls back when no Subject: line exists", () => {
  const cell = "Hello,\n\nJust a body, no subject line.";
  const { subject, body } = splitSubjectAndBody(cell, defaultSubjectFor("Acme"));
  assertEquals(subject, "One workflow idea for Acme");
  assertEquals(body, cell);
});
Deno.test("splitSubjectAndBody preserves paragraphs and line breaks", () => {
  const cell = "Subject: Hi\n\nPara one line one\nPara one line two\n\nPara two.";
  const { body } = splitSubjectAndBody(cell, "fallback");
  assertEquals(body, "Para one line one\nPara one line two\n\nPara two.");
});
Deno.test("splitSubjectAndBody recognizes the Spanish 'Asunto:' marker", () => {
  const cell = "Asunto: Una idea de automatizacion para Acme\n\nHola,\n\nCuerpo del correo.";
  const { subject, body } = splitSubjectAndBody(cell, "fallback");
  assertEquals(subject, "Una idea de automatizacion para Acme");
  assertEquals(body, "Hola,\n\nCuerpo del correo.");
});
Deno.test("splitSubjectAndBody recognizes the French 'Objet:' marker", () => {
  const cell = "Objet: Une idee pour Acme\n\nBonjour,\n\nCorps du message.";
  const { subject } = splitSubjectAndBody(cell, "fallback");
  assertEquals(subject, "Une idee pour Acme");
});

// --- repairing subjects embedded in already-imported bodies ---
Deno.test("extractEmbeddedSubject pulls an Asunto: line out of the body and strips it", () => {
  const body = "Asunto: Una idea para Acme\n\nHola,\n\nCuerpo.";
  const result = extractEmbeddedSubject(body);
  assert(result !== null);
  assertEquals(result!.subject, "Una idea para Acme");
  assertEquals(result!.body, "Hola,\n\nCuerpo.");
});
Deno.test("extractEmbeddedSubject returns null when there is nothing to extract", () => {
  assertEquals(extractEmbeddedSubject("Hola,\n\nJust a normal body."), null);
});

Deno.test("greetingFor uses contact name when present, generic otherwise", () => {
  assertEquals(greetingFor("Marie"), "Hello Marie,");
  assertEquals(greetingFor(""), "Hello,");
  assertEquals(greetingFor(null), "Hello,");
});

// --- template rendering ---
Deno.test("renderTemplate substitutes known variables", () => {
  const ctx = buildTemplateContext({ company: "Acme", contact_name: "Marie", sector: "Retail" });
  const { rendered, missing } = renderTemplate(
    "Hi, I noticed {{company}} works in {{sector}}.",
    ctx,
  );
  assertEquals(rendered, "Hi, I noticed Acme works in Retail.");
  assertEquals(missing.length, 0);
});
Deno.test("renderTemplate reports unresolved variables", () => {
  const ctx = buildTemplateContext({ company: "Acme" });
  const { missing } = renderTemplate("{{company}} - {{pain_points}}", ctx);
  assertEquals(missing, ["pain_points"]);
});
Deno.test("renderTemplate blocks on unresolved variables (send-time contract)", () => {
  const ctx = buildTemplateContext({ company: "" });
  const { missing } = renderTemplate("{{company}}", ctx);
  assert(missing.includes("company"), "an unresolved variable must be reported so callers refuse to send");
});

// --- accented characters / apostrophes survive template rendering ---
Deno.test("renderTemplate preserves accented characters and apostrophes", () => {
  const ctx = buildTemplateContext({ company: "Société Générale d'Automatisation" });
  const { rendered } = renderTemplate("Bonjour {{company}}", ctx);
  assertEquals(rendered, "Bonjour Société Générale d'Automatisation");
});

// --- follow-up eligibility / status exclusion ---
Deno.test("isFollowUpExcludedStatus covers every terminal/opt-out status", () => {
  for (
    const s of [
      "replied", "interested", "meeting_booked", "proposal_sent", "won",
      "not_interested", "do_not_contact", "closed", "bounced", "invalid_email",
    ]
  ) {
    assert(isFollowUpExcludedStatus(s), `${s} should be excluded`);
  }
  assert(!isFollowUpExcludedStatus("initial_sent"));
});

function baseProspect(overrides: Partial<ProspectForEligibility> = {}): ProspectForEligibility {
  return {
    status: "initial_sent",
    do_not_contact: false,
    initial_accepted: true,
    followup1_accepted: false,
    followup1_sent_at: null,
    followup2_sent_at: null,
    followup1_body: "Just checking in on {{company}}.",
    followup2_body: null,
    ...overrides,
  };
}

Deno.test("isEligibleForFollowUp1: eligible when initial accepted, FU1 not sent, body present, status not excluded", () => {
  assert(isEligibleForFollowUp1(baseProspect()));
});
Deno.test("isEligibleForFollowUp1: not eligible if initial email was never accepted by Brevo", () => {
  assert(!isEligibleForFollowUp1(baseProspect({ initial_accepted: false })));
});
Deno.test("isEligibleForFollowUp1: not eligible if follow-up 1 already sent", () => {
  assert(!isEligibleForFollowUp1(baseProspect({ followup1_sent_at: "2026-09-01T00:00:00Z" })));
});
Deno.test("isEligibleForFollowUp1: not eligible if follow-up body is empty", () => {
  assert(!isEligibleForFollowUp1(baseProspect({ followup1_body: "" })));
  assert(!isEligibleForFollowUp1(baseProspect({ followup1_body: null })));
});
Deno.test("isEligibleForFollowUp1: not eligible when do-not-contact is set", () => {
  assert(!isEligibleForFollowUp1(baseProspect({ do_not_contact: true })));
});
Deno.test("isEligibleForFollowUp1: not eligible for excluded statuses (e.g. replied)", () => {
  assert(!isEligibleForFollowUp1(baseProspect({ status: "replied" })));
});

Deno.test("isEligibleForFollowUp2: eligible when FU1 accepted, FU2 not sent, body present, status not excluded", () => {
  const p = baseProspect({
    followup1_accepted: true,
    followup1_sent_at: "2026-09-01T00:00:00Z",
    status: "followup1_sent",
    followup2_body: "One more idea for {{company}}.",
  });
  assert(isEligibleForFollowUp2(p));
});
Deno.test("isEligibleForFollowUp2: not eligible if follow-up 1 was never accepted by Brevo", () => {
  const p = baseProspect({ followup1_accepted: false, status: "followup1_sent", followup2_body: "text" });
  assert(!isEligibleForFollowUp2(p));
});
Deno.test("isEligibleForFollowUp2: not eligible if do-not-contact", () => {
  const p = baseProspect({
    followup1_accepted: true,
    status: "followup1_sent",
    followup2_body: "text",
    do_not_contact: true,
  });
  assert(!isEligibleForFollowUp2(p));
});

// --- webhook secret comparison ---
Deno.test("timingSafeEqual: equal strings", () => {
  assert(timingSafeEqual("abc123", "abc123"));
});
Deno.test("timingSafeEqual: unequal strings and different lengths", () => {
  assert(!timingSafeEqual("abc123", "abc124"));
  assert(!timingSafeEqual("abc", "abcd"));
});
