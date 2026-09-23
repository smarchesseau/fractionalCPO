let bdActiveSendingBatchId = null;
let bdBatchLog = [];
let bdAddToBatchProspectIds = [];

const STAGE_LABELS = { initial: 'Initial', followup1: 'Follow-up 1', followup2: 'Follow-up 2' };
const STAGE_FIELDS = {
  initial: { subject: 'initial_subject', body: 'initial_body', sentAt: 'initial_sent_at' },
  followup1: { subject: 'followup1_subject', body: 'followup1_body', sentAt: 'followup1_sent_at' },
  followup2: { subject: 'followup2_subject', body: 'followup2_body', sentAt: 'followup2_sent_at' },
};

async function bdLoadBatches() {
  const { data, error } = await sb.from('bd_batches').select('*').order('created_at', { ascending: false });
  if (error) { bdToast('Failed to load batches: ' + error.message, 'error'); return; }
  document.getElementById('batchesTbody').innerHTML = data.map((b) => `
    <tr>
      <td>${bdEscapeHtml(b.name)}</td>
      <td>${STAGE_LABELS[b.email_type]}</td>
      <td>${bdFormatDate(b.created_at)}</td>
      <td id="batchCount_${b.id}">…</td>
      <td>${b.completed ? '<span class="bd-badge bd-badge-green">Completed</span>' : b.sending ? '<span class="bd-badge bd-badge-amber">Sending / paused</span>' : '<span class="bd-badge bd-badge-gray">Draft</span>'}</td>
      <td>${b.success_count}</td>
      <td>${b.failure_count}</td>
      <td><button class="bd-btn bd-btn-sm" data-open-batch="${b.id}">Open</button></td>
    </tr>`).join('') || '<tr><td colspan="8" class="bd-muted">No batches yet.</td></tr>';

  document.querySelectorAll('[data-open-batch]').forEach((el) => el.addEventListener('click', () => bdOpenBatchDetail(el.dataset.openBatch)));
  for (const b of data) {
    sb.from('bd_batch_members').select('id', { count: 'exact', head: true }).eq('batch_id', b.id).then(({ count }) => {
      const cell = document.getElementById(`batchCount_${b.id}`);
      if (cell) cell.textContent = count ?? 0;
    });
  }
}

// --- Add-to-batch modal (used from Prospects bulk bar and Follow-up eligible views) ---

function bdOpenAddToBatchModal(prospectIds, defaultType) {
  bdAddToBatchProspectIds = prospectIds;
  const modal = document.getElementById('bdAddToBatchModal');
  document.getElementById('bdAddToBatchTitle').textContent = `Create batch (${prospectIds.length} prospects)`;
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('bdNewBatchName').value = `Batch - ${STAGE_LABELS[defaultType || 'initial']} - ${today}`;
  let typeSelect = document.getElementById('bdNewBatchType');
  if (!typeSelect) {
    typeSelect = document.createElement('select');
    typeSelect.id = 'bdNewBatchType';
    document.getElementById('bdNewBatchName').insertAdjacentElement('afterend', typeSelect);
  }
  typeSelect.innerHTML = Object.entries(STAGE_LABELS).map(([v, l]) => `<option value="${v}" ${v === (defaultType || 'initial') ? 'selected' : ''}>${l}</option>`).join('');
  modal.showModal();
}

document.getElementById('bdAddToBatchConfirmBtn').addEventListener('click', async () => {
  const name = document.getElementById('bdNewBatchName').value.trim();
  const emailType = document.getElementById('bdNewBatchType')?.value || 'initial';
  if (!name) { bdToast('Batch name is required.'); return; }
  document.getElementById('bdAddToBatchModal').close();
  await bdCreateBatch(name, emailType, bdAddToBatchProspectIds);
});

async function bdCreateBatch(name, emailType, prospectIds) {
  const { data: prospects } = await sb.from('bd_prospects').select('*').in('id', prospectIds);
  const { data: settingsRow } = await sb.from('bd_settings').select('default_signature').single();
  const signature = settingsRow?.default_signature || '';
  const fields = STAGE_FIELDS[emailType];
  const skipped = [];
  const members = [];
  let position = 0;

  const seenEmails = new Set();
  for (const p of prospects) {
    if (!p.approved) { skipped.push(`${p.company} (not approved)`); continue; }
    if (p.do_not_contact) { skipped.push(`${p.company} (do not contact)`); continue; }
    if (p[fields.sentAt]) { skipped.push(`${p.company} (${STAGE_LABELS[emailType]} already sent)`); continue; }
    if (!p[fields.body] || !p[fields.body].trim()) { skipped.push(`${p.company} (no ${STAGE_LABELS[emailType]} content)`); continue; }
    if (emailType !== 'initial' && !bdIsFollowUpEligible(p, emailType)) { skipped.push(`${p.company} (not eligible for ${STAGE_LABELS[emailType]})`); continue; }
    if (seenEmails.has(p.email_normalized)) { skipped.push(`${p.company} (duplicate email in selection)`); continue; }
    seenEmails.add(p.email_normalized);

    const ctx = bdBuildTemplateContext(p);
    const { rendered: subject, missing: subjMissing } = bdRenderTemplate(p[fields.subject], ctx);
    const { rendered: bodyRendered, missing: bodyMissing } = bdRenderTemplate(p[fields.body], ctx);
    if (subjMissing.length || bodyMissing.length) { skipped.push(`${p.company} (unresolved variables: ${[...subjMissing, ...bodyMissing].join(', ')})`); continue; }
    const body = bdAppendSignature(bodyRendered, signature);

    members.push({ prospect_id: p.id, position: position++, subject, body, status: 'pending' });
  }

  if (members.length === 0) {
    bdToast('No eligible prospects to add. ' + skipped.join('; '), 'error');
    return;
  }

  const { data: batch, error: batchErr } = await sb.from('bd_batches').insert({ name, email_type: emailType }).select().single();
  if (batchErr) { bdToast('Failed to create batch: ' + batchErr.message, 'error'); return; }

  const { error: membersErr } = await sb.from('bd_batch_members').insert(members.map((m) => ({ ...m, batch_id: batch.id })));
  if (membersErr) { bdToast('Failed to add recipients: ' + membersErr.message, 'error'); return; }

  await bdLogActivity('batch_create', { name, email_type: emailType, count: members.length, skipped: skipped.length }, null, batch.id);
  if (skipped.length) bdToast(`Batch created. Skipped ${skipped.length}: ${skipped.slice(0, 5).join('; ')}${skipped.length > 5 ? '…' : ''}`, 'info');
  else bdToast(`Batch "${name}" created with ${members.length} recipients.`, 'success');

  bdGo('batches');
  bdOpenBatchDetail(batch.id);
}

// --- Batch detail modal ---

function bdBatchMemberStatusBadge(status) {
  const map = { pending: 'gray', sent: 'green', failed: 'red', skipped: 'amber' };
  return `<span class="bd-badge bd-badge-${map[status] || 'gray'}">${status}</span>`;
}

async function bdOpenBatchDetail(batchId) {
  const { data: batch } = await sb.from('bd_batches').select('*').eq('id', batchId).single();
  if (!batch) { bdToast('Batch not found.', 'error'); return; }
  bdBatchLog = [];

  const modal = document.getElementById('bdBatchModal');
  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <h2>${bdEscapeHtml(batch.name)}</h2>
      <button class="bd-btn bd-btn-sm" id="bdBatchCloseBtn">Close</button>
    </div>
    <p class="bd-muted">${STAGE_LABELS[batch.email_type]} email · created ${bdFormatDate(batch.created_at)}</p>
    <div id="bdBatchStats" class="bd-stats-row"></div>
    <div class="bd-progress-bar bd-section-gap"><div class="bd-progress-bar-fill" id="bdBatchProgressFill" style="width:0%"></div></div>
    <div class="bd-card bd-section-gap">
      <div style="display:flex;gap:0.6rem;flex-wrap:wrap;align-items:center;">
        <label>Test recipient <input type="email" id="bdBatchTestRecipient" style="width:220px;"></label>
        <button class="bd-btn" id="bdBatchTestSendBtn">Send test</button>
        <label style="margin-left:1rem;"><input type="checkbox" id="bdBatchApproveCheckbox"> I've reviewed every email in this batch</label>
        <button class="bd-btn bd-btn-primary" id="bdBatchSendBtn" disabled>Confirm and send batch</button>
      </div>
      <p class="bd-muted" id="bdBatchGateNote" style="margin-top:0.5rem;">Send a test to yourself before the batch can be confirmed.</p>
    </div>
    <div class="bd-card bd-section-gap bd-table-wrap">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem;">
        <button class="bd-btn bd-btn-sm" id="bdBatchRefreshFromProspectsBtn">Refresh pending emails from current prospect data</button>
        <span class="bd-muted" style="font-size:0.78rem;">Re-renders subject/body for still-pending recipients from their prospect record. Sent/failed rows are untouched.</span>
      </div>
      <table class="bd-data-table">
        <thead><tr><th>Company</th><th>Email</th><th>Subject / body</th><th>Status</th><th></th></tr></thead>
        <tbody id="bdBatchMembersBody"></tbody>
      </table>
    </div>
    <div class="bd-card bd-section-gap">
      <h3>Send log</h3>
      <div id="bdBatchLogPanel" style="max-height:180px;overflow-y:auto;font-size:0.82rem;"></div>
    </div>
  `;
  document.getElementById('bdBatchCloseBtn').addEventListener('click', () => modal.close());

  const { data: settings } = await sb.from('bd_settings').select('default_test_recipient').single();
  document.getElementById('bdBatchTestRecipient').value = settings?.default_test_recipient || '';

  await bdRefreshBatchDetail(batchId);

  document.getElementById('bdBatchRefreshFromProspectsBtn').addEventListener('click', () => bdRefreshBatchMembersFromProspects(batchId));
  document.getElementById('bdBatchTestSendBtn').addEventListener('click', () => bdSendBatchTest(batchId));
  document.getElementById('bdBatchApproveCheckbox').addEventListener('change', () => bdUpdateSendGate(batchId));
  document.getElementById('bdBatchSendBtn').addEventListener('click', () => bdConfirmAndSendBatch(batchId));

  modal.showModal();
}

async function bdRefreshBatchDetail(batchId) {
  const { data: batch } = await sb.from('bd_batches').select('*').eq('id', batchId).single();
  const { data: members } = await sb.from('bd_batch_members').select('*, bd_prospects(company, email)').eq('batch_id', batchId).order('position');
  if (!batch) return;

  const total = members.length;
  const sent = members.filter((m) => m.status === 'sent').length;
  const failed = members.filter((m) => m.status === 'failed').length;
  const pending = members.filter((m) => m.status === 'pending').length;

  document.getElementById('bdBatchStats').innerHTML = `
    <div class="bd-stat-card"><div class="bd-stat-value">${total}</div><div class="bd-stat-label">Recipients</div></div>
    <div class="bd-stat-card bd-stat-card--success"><div class="bd-stat-value">${sent}</div><div class="bd-stat-label">Sent</div></div>
    <div class="bd-stat-card bd-stat-card--danger"><div class="bd-stat-value">${failed}</div><div class="bd-stat-label">Failed</div></div>
    <div class="bd-stat-card"><div class="bd-stat-value">${pending}</div><div class="bd-stat-label">Pending</div></div>
  `;
  document.getElementById('bdBatchProgressFill').style.width = total ? `${Math.round(((sent + failed) / total) * 100)}%` : '0%';

  document.getElementById('bdBatchMembersBody').innerHTML = members.map((m) => `
    <tr data-member-id="${m.id}">
      <td>${bdEscapeHtml(m.bd_prospects?.company)}</td>
      <td>${bdEscapeHtml(m.bd_prospects?.email)}</td>
      <td class="bd-member-content">
        <details><summary>${bdEscapeHtml(m.subject)}</summary><div class="bd-email-preview">${bdEscapeHtml(m.body)}</div></details>
      </td>
      <td class="bd-member-status">${bdBatchMemberStatusBadge(m.status)}${m.error ? `<br><span style="color:var(--danger-color);font-size:0.75rem;">${bdEscapeHtml(m.error)}</span>` : ''}</td>
      <td>${m.status === 'pending' ? `<button class="bd-btn bd-btn-sm" data-edit-member="${m.id}">Edit</button> <button class="bd-btn bd-btn-sm" data-remove-member="${m.id}">Remove</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="bd-muted">No recipients.</td></tr>';

  document.querySelectorAll('[data-remove-member]').forEach((btn) => btn.addEventListener('click', async () => {
    await sb.from('bd_batch_members').delete().eq('id', btn.dataset.removeMember);
    bdRefreshBatchDetail(batchId);
  }));
  document.querySelectorAll('[data-edit-member]').forEach((btn) => btn.addEventListener('click', () => {
    const memberId = btn.dataset.editMember;
    const member = members.find((m) => m.id === memberId);
    const cell = document.querySelector(`tr[data-member-id="${memberId}"] .bd-member-content`);
    cell.innerHTML = `
      <div class="bd-field-group"><label>Subject</label><input type="text" data-edit-subject value="${bdEscapeHtml(member.subject)}"></div>
      <div class="bd-field-group"><label>Body</label><textarea rows="6" data-edit-body>${bdEscapeHtml(member.body)}</textarea></div>
      <button class="bd-btn bd-btn-sm bd-btn-primary" data-save-member="${memberId}">Save</button>
      <button class="bd-btn bd-btn-sm" data-cancel-edit-member>Cancel</button>`;
    cell.querySelector('[data-save-member]').addEventListener('click', async () => {
      const subject = cell.querySelector('[data-edit-subject]').value.trim();
      const body = cell.querySelector('[data-edit-body]').value.trim();
      if (!subject || !body) { bdToast('Subject and body cannot be empty.', 'error'); return; }
      await sb.from('bd_batch_members').update({ subject, body }).eq('id', memberId);
      bdRefreshBatchDetail(batchId);
    });
    cell.querySelector('[data-cancel-edit-member]').addEventListener('click', () => bdRefreshBatchDetail(batchId));
  }));

  const gateBtn = document.getElementById('bdBatchSendBtn');
  const gateNote = document.getElementById('bdBatchGateNote');
  if (batch.test_sent) gateBtn.dataset.testSent = 'true';
  if (batch.completed) {
    gateBtn.disabled = true;
    gateBtn.textContent = 'Batch completed';
    gateNote.textContent = `Completed: ${batch.success_count} sent, ${batch.failure_count} failed.`;
  } else if (pending === 0 && total > 0) {
    gateBtn.disabled = true;
    gateNote.textContent = 'All recipients already processed.';
  } else if (batch.sending) {
    gateBtn.disabled = true;
    gateBtn.textContent = 'Sending…';
    gateNote.textContent = batch.stopped_reason ? `Paused: ${batch.stopped_reason}. Use Resume to continue.` : 'Currently sending — leave this open or come back later.';
    if (batch.stopped_reason && bdActiveSendingBatchId !== batchId) {
      gateBtn.disabled = false;
      gateBtn.textContent = 'Resume sending';
    }
  } else {
    bdUpdateSendGate(batchId, batch);
  }
}

async function bdRefreshBatchMembersFromProspects(batchId) {
  const btn = document.getElementById('bdBatchRefreshFromProspectsBtn');
  btn.disabled = true;

  const { data: batch } = await sb.from('bd_batches').select('email_type').eq('id', batchId).single();
  const fields = STAGE_FIELDS[batch.email_type];
  const { data: settingsRow } = await sb.from('bd_settings').select('default_signature').single();
  const signature = settingsRow?.default_signature || '';

  const { data: members } = await sb.from('bd_batch_members')
    .select('id, prospect_id, bd_prospects(*)')
    .eq('batch_id', batchId).eq('status', 'pending');

  if (!members || members.length === 0) {
    bdToast('No pending recipients to refresh.');
    btn.disabled = false;
    return;
  }

  let refreshed = 0;
  const blocked = [];
  for (const m of members) {
    const p = m.bd_prospects;
    if (!p) continue;
    const ctx = bdBuildTemplateContext(p);
    const { rendered: subject, missing: subjMissing } = bdRenderTemplate(p[fields.subject], ctx);
    const { rendered: bodyRendered, missing: bodyMissing } = bdRenderTemplate(p[fields.body], ctx);
    if (subjMissing.length || bodyMissing.length) {
      blocked.push(`${p.company} (unresolved: ${[...subjMissing, ...bodyMissing].join(', ')})`);
      continue;
    }
    const body = bdAppendSignature(bodyRendered, signature);
    await sb.from('bd_batch_members').update({ subject, body }).eq('id', m.id);
    refreshed++;
  }

  await bdRefreshBatchDetail(batchId);
  btn.disabled = false;
  const msg = blocked.length
    ? `Refreshed ${refreshed}. Skipped ${blocked.length}: ${blocked.slice(0, 5).join('; ')}${blocked.length > 5 ? '…' : ''}`
    : `Refreshed ${refreshed} recipient(s) from current prospect data.`;
  bdToast(msg, blocked.length ? 'error' : 'success');
}

function bdUpdateSendGate(batchId, batchOverride) {
  const testSentOk = document.getElementById('bdBatchSendBtn').dataset.testSent === 'true';
  const approved = document.getElementById('bdBatchApproveCheckbox').checked;
  const gateBtn = document.getElementById('bdBatchSendBtn');
  const gateNote = document.getElementById('bdBatchGateNote');
  gateBtn.textContent = 'Confirm and send batch';
  gateBtn.disabled = !(testSentOk && approved);
  if (!testSentOk) gateNote.textContent = 'Send a test to yourself before the batch can be confirmed.';
  else if (!approved) gateNote.textContent = 'Tick the review checkbox to enable sending.';
  else gateNote.textContent = 'Ready to send. Sending happens one recipient at a time with a delay between each.';
}

async function bdSendBatchTest(batchId) {
  const { data: batch } = await sb.from('bd_batches').select('email_type').eq('id', batchId).single();
  const { data: members } = await sb.from('bd_batch_members').select('*').eq('batch_id', batchId).order('position').limit(1);
  if (!members || members.length === 0) { bdToast('No recipients to preview.'); return; }
  const testRecipient = document.getElementById('bdBatchTestRecipient').value.trim();
  if (!bdIsValidEmail(testRecipient)) { bdToast('Enter a valid test recipient email.', 'error'); return; }
  const btn = document.getElementById('bdBatchTestSendBtn');
  btn.disabled = true;
  const sample = members[0];
  const result = await bdCallFunction('bd-send-email', {
    mode: 'test', batch_id: batchId, stage: batch.email_type, subject: sample.subject, body: sample.body, test_recipient: testRecipient,
  });
  btn.disabled = false;
  if (!result.ok) { bdToast('Test send failed: ' + (result.reason || result.detail || 'unknown error'), 'error'); return; }
  await sb.from('bd_batches').update({ test_sent: true }).eq('id', batchId);
  document.getElementById('bdBatchSendBtn').dataset.testSent = 'true';
  bdUpdateSendGate(batchId);
  bdToast('Test email sent — check your inbox before confirming the batch.', 'success');
}

function bdAppendBatchLog(line, kind = 'info') {
  const time = new Date().toLocaleTimeString();
  bdBatchLog.unshift(`<div style="color:${kind === 'error' ? 'var(--danger-color)' : kind === 'success' ? 'var(--accent-color)' : 'var(--text-muted)'}">[${time}] ${bdEscapeHtml(line)}</div>`);
  document.getElementById('bdBatchLogPanel').innerHTML = bdBatchLog.join('');
}

let bdSendButtonLock = false;

async function bdConfirmAndSendBatch(batchId) {
  if (bdSendButtonLock) return;
  const { data: batch } = await sb.from('bd_batches').select('*').eq('id', batchId).single();
  const { count: pendingCount } = await sb.from('bd_batch_members').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).eq('status', 'pending');

  bdOpenConfirmModal(
    `Send this batch of ${pendingCount} email(s) now? Sending is manual, one recipient at a time, with a 30-90 second pause between each. You can close this window and come back — sending continues to record progress and won't restart already-sent emails.`,
    async () => {
      bdSendButtonLock = true;
      document.getElementById('bdBatchSendBtn').disabled = true;
      await bdRunBatchSending(batchId, batch.email_type);
      bdSendButtonLock = false;
    },
    { confirmLabel: 'Send batch' },
  );
}

async function bdRunBatchSending(batchId, emailType) {
  if (bdActiveSendingBatchId === batchId) return;
  bdActiveSendingBatchId = batchId;
  await sb.from('bd_batches').update({ sending: true, draft: false, stopped_reason: null }).eq('id', batchId);
  bdAppendBatchLog('Batch sending started.');
  let consecutiveFailures = 0;

  while (true) {
    const { data: member } = await sb.from('bd_batch_members')
      .select('*, bd_prospects(company)')
      .eq('batch_id', batchId).eq('status', 'pending')
      .order('position').limit(1).maybeSingle();
    if (!member) break;

    bdAppendBatchLog(`Sending to ${member.bd_prospects?.company || member.prospect_id}…`);
    const result = await bdCallFunction('bd-send-email', {
      mode: 'send', prospect_id: member.prospect_id, stage: emailType,
      subject: member.subject, body: member.body, batch_id: batchId, batch_member_id: member.id,
    });

    if (result.ok) {
      consecutiveFailures = 0;
      bdAppendBatchLog(`Sent to ${member.bd_prospects?.company || ''}.`, 'success');
    } else {
      bdAppendBatchLog(`Failed for ${member.bd_prospects?.company || ''}: ${result.reason || result.detail || 'unknown error'}`, 'error');

      if (result.reason === 'daily_limit_reached') {
        await sb.from('bd_batches').update({ sending: false, stopped_reason: 'Daily sending limit reached' }).eq('id', batchId);
        bdAppendBatchLog('Stopped: daily sending limit reached.', 'error');
        break;
      }

      if (result.reason === 'brevo_error') {
        // A genuine API failure -- bd-send-email has already marked this
        // member "failed" (not "pending"), so per "do not automatically
        // retry failures" it is never re-attempted by Resume; only the
        // remaining untouched "pending" members continue. Counts toward
        // the 3-consecutive-failures stop.
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          await sb.from('bd_batches').update({ sending: false, stopped_reason: '3 consecutive API failures' }).eq('id', batchId);
          bdAppendBatchLog('Stopped after 3 consecutive API failures. Use Resume once the issue is fixed.', 'error');
          break;
        }
      } else {
        // Structural block (do-not-contact, duplicate stage, invalid email,
        // excluded status). Not an API failure -- mark as skipped and keep
        // going without counting toward the failure streak. The status
        // guard avoids clobbering a row a concurrent request already
        // marked sent/failed (e.g. "already_processing_or_sent").
        await sb.from('bd_batch_members')
          .update({ status: 'skipped', error: JSON.stringify(result.ineligible_reasons || result.reason) })
          .eq('id', member.id)
          .eq('status', 'pending');
      }
    }

    await bdRefreshBatchDetail(batchId);
    bdLoadBatches();
    if (document.getElementById('bdBatchModal').open === false) break;

    const { count: remaining } = await sb.from('bd_batch_members').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).eq('status', 'pending');
    if ((remaining ?? 0) === 0) break;

    const delayMs = 30000 + Math.random() * 60000;
    await bdSleep(delayMs);
  }

  const { count: remaining } = await sb.from('bd_batch_members').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).eq('status', 'pending');
  if ((remaining ?? 0) === 0) {
    await sb.from('bd_batches').update({ sending: false, completed: true }).eq('id', batchId);
    bdAppendBatchLog('Batch completed.', 'success');
    bdToast('Batch completed.', 'success');
  }
  bdActiveSendingBatchId = null;
  await bdRefreshBatchDetail(batchId);
  bdLoadBatches();
}
