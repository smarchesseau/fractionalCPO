let bdAllProspects = [];
let bdSelectedProspectIds = new Set();

async function bdLoadProspects() {
  const { data, error } = await sb.from('bd_prospect_eligibility').select('*').order('created_at', { ascending: false });
  if (error) { bdToast('Failed to load prospects: ' + error.message, 'error'); return; }
  bdAllProspects = data;
  bdPopulateProspectFilters();
  bdRenderProspectsTable();
}

function bdPopulateProspectFilters() {
  const statusSel = document.getElementById('pFilterStatus');
  if (statusSel.options.length <= 1) {
    statusSel.innerHTML = '<option value="">All statuses</option>' + BD_STATUSES.map((s) => `<option value="${s.value}">${s.label}</option>`).join('');
  }
  const priSel = document.getElementById('pFilterPriority');
  const priorities = [...new Set(bdAllProspects.map((p) => p.priority).filter(Boolean))].sort();
  priSel.innerHTML = '<option value="">All priorities</option>' + priorities.map((p) => `<option value="${bdEscapeHtml(p)}">${bdEscapeHtml(p)}</option>`).join('');

  const locSel = document.getElementById('pFilterLocation');
  const selectedLocation = locSel.value;
  const locations = [...new Set(bdAllProspects.map((p) => p.location).filter(Boolean))].sort();
  locSel.innerHTML = '<option value="">All locations</option>' + locations.map((l) => `<option value="${bdEscapeHtml(l)}">${bdEscapeHtml(l)}</option>`).join('');
  if (locations.includes(selectedLocation)) locSel.value = selectedLocation;
}

function bdFilteredProspects() {
  const search = document.getElementById('pFilterSearch').value.trim().toLowerCase();
  const status = document.getElementById('pFilterStatus').value;
  const priority = document.getElementById('pFilterPriority').value;
  const approved = document.getElementById('pFilterApproved').value;
  const dnc = document.getElementById('pFilterDnc').value;
  const location = document.getElementById('pFilterLocation').value;
  return bdAllProspects.filter((p) => {
    if (search && !`${p.company} ${p.contact_name || ''} ${p.email}`.toLowerCase().includes(search)) return false;
    if (status && p.status !== status) return false;
    if (priority && p.priority !== priority) return false;
    if (approved === 'true' && !p.approved) return false;
    if (approved === 'false' && p.approved) return false;
    if (dnc === 'true' && !p.do_not_contact) return false;
    if (dnc === 'false' && p.do_not_contact) return false;
    if (location && p.location !== location) return false;
    return true;
  });
}

function bdRenderProspectsTable() {
  const rows = bdFilteredProspects();
  document.getElementById('prospectsTbody').innerHTML = rows.map((p) => `
    <tr>
      <td><input type="checkbox" class="bd-p-select" data-id="${p.id}" ${bdSelectedProspectIds.has(p.id) ? 'checked' : ''}></td>
      <td><a href="#" data-open="${p.id}">${bdEscapeHtml(p.company)}</a></td>
      <td>${bdEscapeHtml(p.contact_name || '—')}</td>
      <td>${bdEscapeHtml(p.email)}</td>
      <td>${bdRowStatusSelect(p)}</td>
      <td>${bdEscapeHtml(p.priority || '—')}</td>
      <td><input type="checkbox" class="bd-row-approved" data-id="${p.id}" ${p.approved ? 'checked' : ''} title="Approved"></td>
      <td>${bdFormatDate(p.last_contacted_at)}</td>
      <td><button class="bd-btn bd-btn-sm" data-open="${p.id}">Open</button></td>
    </tr>`).join('') || '<tr><td colspan="9" class="bd-muted">No prospects match these filters.</td></tr>';

  document.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); bdOpenProspectDrawer(el.dataset.open); }));
  document.querySelectorAll('.bd-p-select').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) bdSelectedProspectIds.add(cb.dataset.id); else bdSelectedProspectIds.delete(cb.dataset.id);
    bdUpdateProspectBulkBar();
  }));
  document.querySelectorAll('.bd-row-status-select').forEach((sel) => sel.addEventListener('change', () => bdHandleRowStatusChange(sel)));
  document.querySelectorAll('.bd-row-approved').forEach((cb) => cb.addEventListener('change', async () => {
    const { error } = await sb.from('bd_prospects').update({ approved: cb.checked }).eq('id', cb.dataset.id);
    if (error) { bdToast('Failed to update: ' + error.message, 'error'); return; }
    const cached = bdAllProspects.find((p) => p.id === cb.dataset.id);
    if (cached) cached.approved = cb.checked;
    bdToast(cb.checked ? 'Approved.' : 'Approval removed.', 'success');
    bdRenderProspectsTable();
  }));
  bdUpdateProspectBulkBar();
}

function bdRowStatusSelect(p) {
  const color = BD_STATUS_MAP[p.status]?.color;
  const style = BD_BTN_COLOR_VARS[color] ? ` style="border-color:${BD_BTN_COLOR_VARS[color]};color:${BD_BTN_COLOR_VARS[color]}"` : '';
  return `<select class="bd-row-status-select" data-prospect-id="${p.id}" data-current="${p.status}"${style}>
    ${BD_STATUSES.map((s) => `<option value="${s.value}" ${s.value === p.status ? 'selected' : ''}>${s.label}</option>`).join('')}
  </select>`;
}

async function bdHandleRowStatusChange(sel) {
  const id = sel.dataset.prospectId;
  const previous = sel.dataset.current;
  const newStatus = sel.value;
  if (newStatus === previous) return;

  const apply = async () => {
    const update = { status: newStatus };
    if (newStatus === 'do_not_contact') update.do_not_contact = true;
    else if (previous === 'do_not_contact') update.do_not_contact = false;
    await sb.from('bd_prospects').update(update).eq('id', id);
    bdToast('Status updated.', 'success');
    bdLoadProspects();
  };

  if (newStatus === 'do_not_contact') {
    sel.value = previous; // revert visually until confirmed; re-render applies the real value on confirm
    bdOpenConfirmModal(
      'Mark this prospect as do-not-contact? They will be excluded from all future sending.',
      apply,
      { danger: true, confirmLabel: 'Mark do-not-contact' },
    );
  } else {
    await apply();
  }
}

function bdUpdateProspectBulkBar() {
  const bar = document.getElementById('prospectBulkBar');
  bar.hidden = bdSelectedProspectIds.size === 0;
  document.getElementById('prospectSelectedCount').textContent = `${bdSelectedProspectIds.size} selected`;
}

['pFilterSearch', 'pFilterStatus', 'pFilterPriority', 'pFilterApproved', 'pFilterDnc', 'pFilterLocation'].forEach((id) => {
  document.getElementById(id).addEventListener('input', bdRenderProspectsTable);
});

document.getElementById('pSelectAll').addEventListener('change', (e) => {
  const ids = bdFilteredProspects().map((p) => p.id);
  if (e.target.checked) ids.forEach((id) => bdSelectedProspectIds.add(id));
  else ids.forEach((id) => bdSelectedProspectIds.delete(id));
  bdRenderProspectsTable();
});

document.getElementById('exportProspectsBtn').addEventListener('click', () => bdExportProspects(bdFilteredProspects()));

function bdExportProspects(rows) {
  bdDownloadCsv('bd_prospects.csv', [
    'company', 'contact_name', 'email', 'location', 'sector', 'priority', 'status',
    'approved', 'do_not_contact', 'initial_sent_at', 'followup1_sent_at', 'followup2_sent_at', 'notes',
  ], rows);
}

document.querySelectorAll('#prospectBulkBar [data-bulk]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const ids = [...bdSelectedProspectIds];
    if (ids.length === 0) return;
    const action = btn.dataset.bulk;
    if (action === 'approve') {
      await sb.from('bd_prospects').update({ approved: true }).in('id', ids);
      bdToast(`Approved ${ids.length} prospects.`, 'success');
    } else if (action === 'unapprove') {
      await sb.from('bd_prospects').update({ approved: false }).in('id', ids);
      bdToast(`Removed approval from ${ids.length} prospects.`, 'success');
    } else if (action === 'undnc') {
      await sb.from('bd_prospects').update({ do_not_contact: false }).in('id', ids);
      bdToast(`Cleared do-not-contact for ${ids.length} prospects.`, 'success');
    } else if (action === 'dnc') {
      bdOpenConfirmModal(`Mark ${ids.length} prospects as do-not-contact? They will be excluded from all future sending.`, async () => {
        await sb.from('bd_prospects').update({ do_not_contact: true, status: 'do_not_contact' }).in('id', ids);
        bdToast('Marked do-not-contact.', 'success');
        bdSelectedProspectIds.clear();
        bdLoadProspects();
      }, { danger: true, confirmLabel: 'Mark do-not-contact' });
      return;
    } else if (action === 'batch') {
      bdOpenAddToBatchModal(ids);
      return;
    } else if (action === 'export') {
      bdExportProspects(bdAllProspects.filter((p) => ids.includes(p.id)));
      return;
    } else if (action === 'delete') {
      bdOpenConfirmModal(`Permanently delete ${ids.length} prospects? This cannot be undone.`, async () => {
        await sb.from('bd_prospects').delete().in('id', ids);
        bdToast('Deleted.', 'success');
        bdSelectedProspectIds.clear();
        bdLoadProspects();
      }, { danger: true, confirmLabel: 'Delete permanently' });
      return;
    }
    bdSelectedProspectIds.clear();
    bdLoadProspects();
  });
});

// --- Prospect detail drawer ---

const BD_MANUAL_ACTIONS = [
  { status: 'replied', label: 'Mark replied', color: 'purple' },
  { status: 'interested', label: 'Mark interested', color: 'purple' },
  { status: 'meeting_booked', label: 'Mark meeting booked', color: 'purple' },
  { status: 'proposal_sent', label: 'Mark proposal sent', color: 'purple' },
  { status: 'won', label: 'Mark won', color: 'green' },
  { status: 'not_interested', label: 'Mark not interested', color: 'red' },
  { status: 'invalid_email', label: 'Mark invalid email', color: 'red' },
  { status: 'bounced', label: 'Mark bounced', color: 'red' },
  { status: 'do_not_contact', label: 'Mark do not contact', danger: true },
  { status: 'closed', label: 'Close prospect', color: 'gray' },
];
const BD_BTN_COLOR_VARS = { purple: 'var(--purple-color)', green: 'var(--accent-color)', red: 'var(--danger-color)', gray: 'var(--text-muted)' };

async function bdOpenProspectDrawer(id) {
  const { data: p, error } = await sb.from('bd_prospects').select('*').eq('id', id).single();
  if (error || !p) { bdToast('Failed to load prospect.', 'error'); return; }
  document.getElementById('bdDrawerOverlay').classList.add('open');

  const { data: batchMembers } = await sb.from('bd_batch_members').select('*, bd_batches(name, email_type, sending, completed)').eq('prospect_id', id);
  const { data: history } = await sb.from('bd_activity').select('*').eq('prospect_id', id).order('occurred_at', { ascending: false });
  const { data: settingsRow } = await sb.from('bd_settings').select('default_signature').single();
  const signature = settingsRow?.default_signature || '';

  const ctx = bdBuildTemplateContext(p);
  const stageSection = (stage, label, subjectField, bodyField, sentField, acceptedField, msgField, errField) => {
    const { rendered: subj, missing: subjMissing } = bdRenderTemplate(p[subjectField], ctx);
    const { rendered: bodyRaw, missing: bodyMissing } = bdRenderTemplate(p[bodyField], ctx);
    const body = bdAppendSignature(bodyRaw, signature);
    const missing = [...new Set([...subjMissing, ...bodyMissing])];
    return `
      <div class="bd-card">
        <h3>${label} ${p[sentField] ? `<span class="bd-badge bd-badge-green">Sent ${bdFormatDate(p[sentField])}</span>` : '<span class="bd-badge bd-badge-gray">Not sent</span>'}</h3>
        ${missing.length ? `<div class="bd-warning-banner">Missing values for: ${missing.join(', ')} — fill these in or edit the text directly.</div>` : ''}
        <div class="bd-field-group"><label>Subject</label><input type="text" data-field="${subjectField}" value="${bdEscapeHtml(p[subjectField] || '')}"></div>
        <div class="bd-field-group"><label>Body</label><textarea rows="8" data-field="${bodyField}">${bdEscapeHtml(p[bodyField] || '')}</textarea></div>
        <div class="bd-email-preview"><strong>${bdEscapeHtml(subj)}</strong>\n\n${bdEscapeHtml(body)}</div>
        ${signature ? '<p class="bd-muted" style="font-size:0.78rem;margin-top:0.3rem;">Preview includes your default signature from Settings.</p>' : ''}
        <div class="bd-muted" style="margin-top:0.5rem;font-size:0.8rem;">
          ${p[msgField] ? 'Message ID: ' + bdEscapeHtml(p[msgField]) : 'Not sent yet.'}
          ${p[errField] ? '<br><span style="color:var(--danger-color)">Error: ' + bdEscapeHtml(p[errField]) + '</span>' : ''}
        </div>
        <button class="bd-btn bd-btn-sm bd-section-gap" data-send-test="${stage}">Send test to myself</button>
        <button class="bd-btn bd-btn-sm bd-btn-primary bd-section-gap" data-single-send="${stage}">Send to this prospect only</button>
        <p class="bd-muted" style="font-size:0.75rem;margin-top:0.3rem;">Opens a one-recipient batch — still requires a test send and confirmation before it actually goes out.</p>
      </div>`;
  };

  const drawer = document.getElementById('bdProspectDrawer');
  drawer.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <h2>${bdEscapeHtml(p.company)}</h2>
      <button class="bd-btn bd-btn-sm" id="bdDrawerCloseBtn">Close</button>
    </div>
    ${bdStatusBadge(p.status)} ${p.do_not_contact ? '<span class="bd-badge bd-badge-red">Do not contact</span>' : ''}

    <div class="bd-card bd-section-gap">
      <h3>Details</h3>
      <div class="bd-field-row">
        ${['company', 'contact_name', 'email', 'location', 'sector', 'employee_range', 'size_confidence', 'target_decision_maker', 'priority', 'email_verification', 'source_url'].map((f) => `
          <div class="bd-field-group"><label>${f.replace(/_/g, ' ')}</label><input type="text" data-field="${f}" value="${bdEscapeHtml(p[f] || '')}"></div>
        `).join('')}
      </div>
      <div class="bd-field-group"><label>Likely pain points</label><textarea rows="2" data-field="pain_points">${bdEscapeHtml(p.pain_points || '')}</textarea></div>
      <div class="bd-field-group"><label>Automation opportunities</label><textarea rows="2" data-field="automation_opportunities">${bdEscapeHtml(p.automation_opportunities || '')}</textarea></div>
      <div class="bd-field-group"><label>Notes</label><textarea rows="3" data-field="notes">${bdEscapeHtml(p.notes || '')}</textarea></div>
      <button class="bd-btn bd-btn-primary" id="bdDrawerSaveBtn">Save changes</button>
      <button class="bd-btn" id="bdDrawerToggleApproveBtn">${p.approved ? 'Un-approve' : 'Approve'}</button>
      ${p.do_not_contact ? `<button class="bd-btn" id="bdDrawerClearDncBtn">Clear do-not-contact</button>` : ''}
    </div>

    <div class="bd-card">
      <h3>Manual actions</h3>
      <div style="display:flex;flex-wrap:wrap;gap:0.5rem;">
        ${BD_MANUAL_ACTIONS.map((a) => {
          const style = !a.danger && a.color ? ` style="border-color:${BD_BTN_COLOR_VARS[a.color]};color:${BD_BTN_COLOR_VARS[a.color]}"` : '';
          return `<button class="bd-btn bd-btn-sm ${a.danger ? 'bd-btn-danger' : ''}"${style} data-manual-status="${a.status}">${a.label}</button>`;
        }).join('')}
        <button class="bd-btn bd-btn-sm" id="bdDrawerUndoBtn">Undo last status change</button>
      </div>
    </div>

    ${stageSection('initial', 'Initial email', 'initial_subject', 'initial_body', 'initial_sent_at', 'initial_accepted', 'initial_message_id', 'initial_send_error')}
    ${stageSection('followup1', 'Follow-up 1', 'followup1_subject', 'followup1_body', 'followup1_sent_at', 'followup1_accepted', 'followup1_message_id', 'followup1_send_error')}
    ${stageSection('followup2', 'Follow-up 2', 'followup2_subject', 'followup2_body', 'followup2_sent_at', 'followup2_accepted', 'followup2_message_id', 'followup2_send_error')}

    <div class="bd-card">
      <h3>Batches</h3>
      ${(batchMembers || []).map((m) => `<div style="padding:0.3rem 0;border-bottom:1px solid var(--border-color);font-size:0.85rem;">${bdEscapeHtml(m.bd_batches?.name)} — ${bdEscapeHtml(m.bd_batches?.email_type)} — ${bdEscapeHtml(m.status)}</div>`).join('') || '<p class="bd-muted">Not in any batch.</p>'}
    </div>

    <div class="bd-card">
      <h3>Status history</h3>
      ${(history || []).map((h) => `<div style="padding:0.3rem 0;border-bottom:1px solid var(--border-color);font-size:0.8rem;"><span class="bd-muted">${bdFormatDate(h.occurred_at)}</span> — ${bdEscapeHtml(h.action)} ${h.details ? bdEscapeHtml(JSON.stringify(h.details)) : ''}</div>`).join('') || '<p class="bd-muted">No history yet.</p>'}
    </div>
  `;

  document.getElementById('bdDrawerCloseBtn').addEventListener('click', bdCloseDrawer);
  document.getElementById('bdDrawerSaveBtn').addEventListener('click', () => bdSaveProspectFromDrawer(p.id));
  document.getElementById('bdDrawerToggleApproveBtn').addEventListener('click', async () => {
    const newApproved = !p.approved;
    await sb.from('bd_prospects').update({ approved: newApproved }).eq('id', p.id);
    bdToast(newApproved ? 'Approved.' : 'Approval removed.', 'success');
    bdOpenProspectDrawer(p.id);
    bdLoadProspects();
  });
  document.getElementById('bdDrawerClearDncBtn')?.addEventListener('click', () => {
    bdOpenConfirmModal('Clear do-not-contact for this prospect?', async () => {
      await sb.from('bd_prospects').update({ do_not_contact: false, status: p.status === 'do_not_contact' ? 'new' : p.status }).eq('id', p.id);
      bdToast('Do-not-contact cleared.', 'success');
      bdOpenProspectDrawer(p.id);
      bdLoadProspects();
    }, { confirmLabel: 'Clear' });
  });
  drawer.querySelectorAll('[data-manual-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const status = btn.dataset.manualStatus;
      bdOpenConfirmModal(`Set status to "${BD_STATUS_MAP[status].label}"?`, async () => {
        const update = { status };
        if (status === 'do_not_contact') update.do_not_contact = true;
        await sb.from('bd_prospects').update(update).eq('id', p.id);
        bdToast('Status updated.', 'success');
        bdOpenProspectDrawer(p.id);
        bdLoadProspects();
      }, { danger: !!BD_MANUAL_ACTIONS.find((a) => a.status === status)?.danger, confirmLabel: 'Confirm' });
    });
  });
  document.getElementById('bdDrawerUndoBtn').addEventListener('click', async () => {
    const lastChange = (history || []).find((h) => h.action === 'status_change');
    if (!lastChange) { bdToast('No status change to undo.'); return; }
    await sb.from('bd_prospects').update({ status: lastChange.details.from }).eq('id', p.id);
    bdToast(`Reverted to "${BD_STATUS_MAP[lastChange.details.from]?.label || lastChange.details.from}".`, 'success');
    bdOpenProspectDrawer(p.id);
    bdLoadProspects();
  });
  drawer.querySelectorAll('[data-send-test]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const stage = btn.dataset.sendTest;
      const subjField = stage === 'initial' ? 'initial_subject' : stage === 'followup1' ? 'followup1_subject' : 'followup2_subject';
      const bodyField = stage === 'initial' ? 'initial_body' : stage === 'followup1' ? 'followup1_body' : 'followup2_body';
      const subjInput = drawer.querySelector(`[data-field="${subjField}"]`).value;
      const bodyInput = drawer.querySelector(`[data-field="${bodyField}"]`).value;
      const { rendered: subj } = bdRenderTemplate(subjInput, ctx);
      const { rendered: bodyRendered } = bdRenderTemplate(bodyInput, ctx);
      const body = bdAppendSignature(bodyRendered, signature);
      btn.disabled = true;
      const result = await bdCallFunction('bd-send-email', { mode: 'test', prospect_id: p.id, stage, subject: subj, body });
      btn.disabled = false;
      if (result.ok) bdToast('Test email sent.', 'success');
      else bdToast('Test send failed: ' + (result.reason || result.detail || 'unknown error'), 'error');
    });
  });
  drawer.querySelectorAll('[data-single-send]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stage = btn.dataset.singleSend;
      const name = `Single send - ${p.company} - ${STAGE_LABELS[stage]} - ${new Date().toISOString().slice(0, 10)}`;
      bdCloseDrawer();
      bdCreateBatch(name, stage, [p.id]);
    });
  });
}

async function bdSaveProspectFromDrawer(id) {
  const drawer = document.getElementById('bdProspectDrawer');
  const update = {};
  drawer.querySelectorAll('[data-field]').forEach((el) => { update[el.dataset.field] = el.value; });
  if (update.email && !bdIsValidEmail(update.email)) {
    bdToast('That email address is not valid.', 'error');
    return;
  }
  const { error } = await sb.from('bd_prospects').update(update).eq('id', id);
  if (error) { bdToast('Save failed: ' + error.message, 'error'); return; }
  bdToast('Saved.', 'success');
  bdLoadProspects();
}

function bdCloseDrawer() {
  document.getElementById('bdDrawerOverlay').classList.remove('open');
}
