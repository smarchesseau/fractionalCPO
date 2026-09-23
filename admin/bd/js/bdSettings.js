async function bdLoadSettings() {
  const { data: settings, error } = await sb.from('bd_settings').select('*').single();
  if (error) { bdToast('Failed to load settings: ' + error.message, 'error'); return; }

  document.getElementById('setFu1Days').value = settings.follow_up_1_min_days;
  document.getElementById('setFu2DaysAfterFu1').value = settings.follow_up_2_min_days_after_fu1;
  document.getElementById('setFu2DaysAfterInitial').value = settings.follow_up_2_min_days_after_initial;
  document.getElementById('setDailyLimit').value = settings.daily_send_limit;
  document.getElementById('setTestRecipient').value = settings.default_test_recipient || '';
  document.getElementById('setReplyTo').value = settings.reply_to_email || '';
  document.getElementById('setSignature').value = settings.default_signature || '';

  const status = await bdCallFunction('bd-config-status', {});
  const statusEl = document.getElementById('settingsBrevoStatus');
  if (!status.ok) {
    statusEl.innerHTML = `<span class="bd-badge bd-badge-red">Could not check status</span>`;
  } else {
    statusEl.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:0.5rem;">
        <span class="bd-badge bd-badge-${status.brevo_configured ? 'green' : 'red'}">Brevo API key: ${status.brevo_configured ? 'configured' : 'missing'}</span>
        <span class="bd-badge bd-badge-${status.sender_configured ? 'green' : 'red'}">Sender: ${status.sender_configured ? 'configured' : 'missing'}</span>
        <span class="bd-badge bd-badge-${status.real_sending_enabled ? 'amber' : 'gray'}">Real sending: ${status.real_sending_enabled ? 'ENABLED' : 'disabled'}</span>
        <span class="bd-badge bd-badge-${status.daily_limit_reached ? 'red' : 'green'}">Today: ${status.sent_today}/${status.daily_limit} sent</span>
      </div>`;
  }
}

document.getElementById('settingsTestConnectionBtn').addEventListener('click', async () => {
  const btn = document.getElementById('settingsTestConnectionBtn');
  btn.disabled = true;
  const result = await bdCallFunction('bd-send-email', { mode: 'test_connection' });
  btn.disabled = false;
  if (result.connected) bdToast('Brevo connection OK.', 'success');
  else bdToast('Brevo connection failed: ' + (result.reason || 'unknown'), 'error');
});

document.getElementById('settingsRepairSubjectsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('settingsRepairSubjectsBtn');
  const resultEl = document.getElementById('settingsRepairResult');
  btn.disabled = true;
  resultEl.textContent = 'Scanning…';

  const { data: prospects, error } = await sb.from('bd_prospects')
    .select('id, company, initial_subject, initial_body, followup1_subject, followup1_body, followup2_subject, followup2_body');
  if (error) {
    resultEl.textContent = 'Failed to load prospects: ' + error.message;
    btn.disabled = false;
    return;
  }

  const stages = [
    { subjectField: 'initial_subject', bodyField: 'initial_body' },
    { subjectField: 'followup1_subject', bodyField: 'followup1_body' },
    { subjectField: 'followup2_subject', bodyField: 'followup2_body' },
  ];

  const updates = [];
  let linesFixed = 0;
  for (const p of prospects) {
    const patch = {};
    let touched = false;
    for (const { subjectField, bodyField } of stages) {
      const extracted = bdExtractEmbeddedSubject(p[bodyField]);
      if (!extracted) continue;
      patch[subjectField] = extracted.subject;
      patch[bodyField] = extracted.body;
      touched = true;
      linesFixed++;
    }
    if (touched) updates.push({ id: p.id, company: p.company, patch });
  }

  if (updates.length === 0) {
    resultEl.textContent = 'Nothing to repair — no embedded subject lines found.';
    btn.disabled = false;
    return;
  }

  resultEl.textContent = `Fixing ${updates.length} prospect(s)…`;
  const results = await Promise.all(updates.map((u) => sb.from('bd_prospects').update(u.patch).eq('id', u.id)));
  const failed = results.filter((r) => r.error);

  await bdLogActivity('bulk_subject_repair', { prospects_fixed: updates.length, lines_fixed: linesFixed, failed: failed.length });

  resultEl.textContent = failed.length > 0
    ? `Fixed ${updates.length - failed.length} of ${updates.length} prospects (${linesFixed} lines extracted). ${failed.length} failed -- check console.`
    : `Fixed ${updates.length} prospect(s), ${linesFixed} embedded subject line(s) extracted.`;
  if (failed.length > 0) console.error('bd repair failures:', failed);
  btn.disabled = false;
  bdToast(`Repair complete: ${updates.length - failed.length} prospect(s) fixed.`, failed.length ? 'error' : 'success');
});

const BD_SIGNATURE_MARKER = 'AI · Automation · Product';

document.getElementById('settingsStripSignatureBtn').addEventListener('click', async () => {
  const btn = document.getElementById('settingsStripSignatureBtn');
  const resultEl = document.getElementById('settingsStripSignatureResult');
  btn.disabled = true;
  resultEl.textContent = 'Scanning…';

  const { data: prospects, error } = await sb.from('bd_prospects')
    .select('id, company, initial_body, followup1_body, followup2_body');
  if (error) {
    resultEl.textContent = 'Failed to load prospects: ' + error.message;
    btn.disabled = false;
    return;
  }

  const bodyFields = ['initial_body', 'followup1_body', 'followup2_body'];
  const updates = [];
  let blocksStripped = 0;
  for (const p of prospects) {
    const patch = {};
    let touched = false;
    for (const field of bodyFields) {
      const stripped = bdStripSignatureBlock(p[field], BD_SIGNATURE_MARKER);
      if (stripped === null) continue;
      patch[field] = stripped;
      touched = true;
      blocksStripped++;
    }
    if (touched) updates.push({ id: p.id, patch });
  }

  if (updates.length === 0) {
    resultEl.textContent = 'Nothing to strip — no bodies contained that signature block.';
    btn.disabled = false;
    return;
  }

  resultEl.textContent = `Stripping signatures from ${updates.length} prospect(s)…`;
  const results = await Promise.all(updates.map((u) => sb.from('bd_prospects').update(u.patch).eq('id', u.id)));
  const failed = results.filter((r) => r.error);

  await bdLogActivity('bulk_signature_strip', { prospects_fixed: updates.length, blocks_stripped: blocksStripped, failed: failed.length });

  resultEl.textContent = failed.length > 0
    ? `Fixed ${updates.length - failed.length} of ${updates.length} prospects (${blocksStripped} blocks stripped). ${failed.length} failed -- check console.`
    : `Fixed ${updates.length} prospect(s), ${blocksStripped} signature block(s) stripped.`;
  if (failed.length > 0) console.error('bd signature strip failures:', failed);
  btn.disabled = false;
  bdToast(`Strip complete: ${updates.length - failed.length} prospect(s) fixed.`, failed.length ? 'error' : 'success');
});

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const update = {
    follow_up_1_min_days: Number(document.getElementById('setFu1Days').value),
    follow_up_2_min_days_after_fu1: Number(document.getElementById('setFu2DaysAfterFu1').value),
    follow_up_2_min_days_after_initial: Number(document.getElementById('setFu2DaysAfterInitial').value),
    daily_send_limit: Number(document.getElementById('setDailyLimit').value),
    default_test_recipient: document.getElementById('setTestRecipient').value.trim(),
    reply_to_email: document.getElementById('setReplyTo').value.trim(),
    default_signature: document.getElementById('setSignature').value,
  };
  const { error } = await sb.from('bd_settings').update(update).eq('id', '00000000-0000-0000-0000-0000000000b1');
  if (error) { bdToast('Failed to save settings: ' + error.message, 'error'); return; }
  bdToast('Settings saved.', 'success');
});
