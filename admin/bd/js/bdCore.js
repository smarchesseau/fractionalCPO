// Shared helpers used by every bd* panel script. Mirrors the pure logic in
// supabase/functions/_shared/bdLogic.ts (that copy is authoritative for
// send-time enforcement; this one drives the UI/preview).

const BD_STATUSES = [
  { value: 'new', label: 'New', color: 'gray' },
  { value: 'initial_sent', label: 'Initial email sent', color: 'green' },
  { value: 'followup1_sent', label: 'Follow-up 1 sent', color: 'green' },
  { value: 'followup2_sent', label: 'Follow-up 2 sent', color: 'green' },
  { value: 'replied', label: 'Replied', color: 'purple' },
  { value: 'interested', label: 'Interested', color: 'purple' },
  { value: 'meeting_booked', label: 'Meeting booked', color: 'purple' },
  { value: 'proposal_sent', label: 'Proposal sent', color: 'purple' },
  { value: 'won', label: 'Won', color: 'green' },
  { value: 'not_interested', label: 'Not interested', color: 'red' },
  { value: 'invalid_email', label: 'Invalid email', color: 'red' },
  { value: 'bounced', label: 'Bounced', color: 'red' },
  { value: 'do_not_contact', label: 'Do not contact', color: 'red' },
  { value: 'closed', label: 'Closed', color: 'gray' },
];
const BD_STATUS_MAP = Object.fromEntries(BD_STATUSES.map((s) => [s.value, s]));

const BD_FOLLOW_UP_EXCLUDED_STATUSES = new Set([
  'replied', 'interested', 'meeting_booked', 'proposal_sent', 'won',
  'not_interested', 'do_not_contact', 'closed', 'bounced', 'invalid_email',
]);

function bdStatusBadge(status) {
  const s = BD_STATUS_MAP[status] || { label: status, color: 'gray' };
  return `<span class="bd-badge bd-badge-${s.color}">${bdEscapeHtml(s.label)}</span>`;
}

function bdEscapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function bdIsValidEmail(email) {
  if (!email) return false;
  const trimmed = String(email).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 254;
}

function bdNormalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function bdDefaultSubjectFor(company) {
  return `One workflow idea for ${company}`;
}

const BD_SUBJECT_MARKER_RE = /(?:^|\n)[ \t]*(?:Subject|Asunto|Objet)[ \t]*:[ \t]*(.+?)[ \t]*\r?\n+/i;

function bdSplitSubjectAndBody(cellText, defaultSubject) {
  const text = String(cellText ?? '').replace(/\r\n/g, '\n');
  const match = text.match(BD_SUBJECT_MARKER_RE);
  if (match) {
    const body = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
    return { subject: match[1].trim(), body };
  }
  return { subject: defaultSubject, body: text.trim() };
}

// Finds a Subject:/Asunto:/Objet: line already embedded inside a body that
// was imported before the parser recognized non-English markers, and pulls
// it out. Used by the one-off "repair embedded subjects" tool in Settings.
function bdExtractEmbeddedSubject(bodyText) {
  const text = String(bodyText ?? '').replace(/\r\n/g, '\n');
  const match = text.match(BD_SUBJECT_MARKER_RE);
  if (!match) return null;
  const body = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  return { subject: match[1].trim(), body };
}

function bdGreetingFor(contactName) {
  const name = String(contactName ?? '').trim();
  return name ? `Hello ${name},` : 'Hello,';
}

function bdBuildTemplateContext(prospect) {
  return {
    company: prospect.company ?? '',
    contact_name: prospect.contact_name ?? '',
    location: prospect.location ?? '',
    sector: prospect.sector ?? '',
    pain_points: prospect.pain_points ?? '',
    automation_opportunities: prospect.automation_opportunities ?? '',
  };
}

function bdRenderTemplate(templateStr, ctx) {
  const missing = [];
  const rendered = String(templateStr ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    const value = ctx[key];
    if (value === undefined || value === null || String(value).trim() === '') {
      missing.push(key);
      return '';
    }
    return String(value);
  });
  return { rendered, missing: [...new Set(missing)] };
}

function bdIsFollowUpEligible(prospect, stage) {
  if (prospect.do_not_contact) return false;
  if (BD_FOLLOW_UP_EXCLUDED_STATUSES.has(prospect.status)) return false;
  if (stage === 'followup1') {
    return !!prospect.initial_accepted && !prospect.followup1_sent_at && !!(prospect.followup1_body || '').trim();
  }
  if (stage === 'followup2') {
    return !!prospect.followup1_accepted && !prospect.followup2_sent_at && !!(prospect.followup2_body || '').trim();
  }
  return false;
}

function bdToast(message, kind = 'info') {
  let root = document.getElementById('bdToastRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'bdToastRoot';
    root.className = 'bd-toast-root';
    document.body.appendChild(root);
  }
  const el = document.createElement('div');
  el.className = `bd-toast bd-toast-${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function bdOpenConfirmModal(message, onConfirm, opts = {}) {
  const modal = document.getElementById('bdConfirmModal');
  document.getElementById('bdConfirmMessage').textContent = message;
  const confirmBtn = document.getElementById('bdConfirmBtn');
  confirmBtn.textContent = opts.confirmLabel || 'Confirm';
  confirmBtn.className = `bd-btn ${opts.danger ? 'bd-btn-danger' : 'bd-btn-primary'}`;
  const newBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
  newBtn.addEventListener('click', () => {
    modal.close();
    onConfirm();
  });
  modal.showModal();
}

function bdCsvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function bdDownloadCsv(filename, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => bdCsvEscape(row[h])).join(','));
  }
  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function bdFormatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function bdDaysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

async function bdLogActivity(action, details = {}, prospectId = null, batchId = null) {
  await sb.from('bd_activity').insert({ action, details, prospect_id: prospectId, batch_id: batchId });
}

function bdSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Appends the configured default signature to a rendered email body. Called
// wherever a final send/test/preview body is composed, so every outgoing
// email -- and everything shown in a preview -- includes it consistently.
function bdAppendSignature(body, signature) {
  const sig = String(signature ?? '').trim();
  if (!sig) return body;
  return `${body}\n\n${sig}`;
}

// One-off repair: some imported bodies already end with their own sign-off,
// which would otherwise get a second, duplicate signature appended on send.
// Removes only the LINE containing `markerText` onward -- not the whole
// trailing paragraph -- so a closing like "Cheers,\nStephanie" that sits on
// the same paragraph as the tagline (no blank line between them) is kept.
// Returns null when the marker isn't found.
function bdStripSignatureBlock(body, markerText) {
  const text = String(body ?? '');
  const idx = text.indexOf(markerText);
  if (idx === -1) return null;
  const lineStart = text.lastIndexOf('\n', idx) + 1; // 0 if marker is on the first line
  return text.slice(0, lineStart).replace(/\s+$/, '');
}
