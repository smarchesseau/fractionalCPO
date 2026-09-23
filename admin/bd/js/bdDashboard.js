async function bdLoadDashboard() {
  const { data: prospects, error } = await sb.from('bd_prospect_eligibility').select('*');
  if (error) { bdToast('Failed to load dashboard: ' + error.message, 'error'); return; }

  const counts = {};
  for (const s of BD_STATUSES) counts[s.value] = 0;
  let approvedCount = 0, dncCount = 0, fu1Eligible = 0, fu2Eligible = 0;
  for (const p of prospects) {
    counts[p.status] = (counts[p.status] || 0) + 1;
    if (p.approved) approvedCount++;
    if (p.do_not_contact) dncCount++;
    if (p.fu1_eligible) fu1Eligible++;
    if (p.fu2_eligible) fu2Eligible++;
  }
  const total = prospects.length;

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count: sentToday } = await sb.from('bd_batch_members').select('id', { count: 'exact', head: true }).eq('status', 'sent').gte('sent_at', startOfDay.toISOString());
  const { data: settings } = await sb.from('bd_settings').select('daily_send_limit').single();
  const dailyLimit = settings?.daily_send_limit ?? 20;

  const stats = [
    ['Total prospects', total], ['New', counts.new],
    ['Approved', approvedCount], ['Initial sent', counts.initial_sent],
    ['Follow-up 1 sent', counts.followup1_sent], ['Follow-up 2 sent', counts.followup2_sent],
    ['Replied', counts.replied], ['Interested', counts.interested],
    ['Meeting booked', counts.meeting_booked], ['Proposal sent', counts.proposal_sent],
    ['Won', counts.won], ['Not interested', counts.not_interested], ['Bounced', counts.bounced],
    ['Do not contact', dncCount], ['Eligible for FU1', fu1Eligible], ['Eligible for FU2', fu2Eligible],
    ['Sent today', sentToday ?? 0], ['Remaining today', Math.max(0, dailyLimit - (sentToday ?? 0))],
  ];
  document.getElementById('dashStats').innerHTML = stats.map(([label, val]) => `
    <div class="bd-stat-card"><div class="bd-stat-value">${val}</div><div class="bd-stat-label">${bdEscapeHtml(label)}</div></div>
  `).join('');

  document.getElementById('dashPipeline').innerHTML = BD_STATUSES.map((s) => `
    <div style="display:flex;justify-content:space-between;padding:0.3rem 0;border-bottom:1px solid var(--border-color);">
      <span>${bdStatusBadge(s.value)}</span><span>${counts[s.value] || 0}</span>
    </div>
  `).join('');

  const { data: activity } = await sb.from('bd_activity').select('*, bd_prospects(company)').order('occurred_at', { ascending: false }).limit(10);
  document.getElementById('dashActivity').innerHTML = (activity || []).map((a) => `
    <div style="padding:0.3rem 0;border-bottom:1px solid var(--border-color);font-size:0.85rem;">
      <span class="bd-muted">${bdFormatDate(a.occurred_at)}</span> — ${bdEscapeHtml(a.action)}${a.bd_prospects?.company ? ' · ' + bdEscapeHtml(a.bd_prospects.company) : ''}
    </div>
  `).join('') || '<p class="bd-muted">No activity yet.</p>';

  const { data: batches } = await sb.from('bd_batches').select('*').order('created_at', { ascending: false }).limit(5);
  document.getElementById('dashBatches').innerHTML = (batches || []).map((b) => `
    <div style="padding:0.3rem 0;border-bottom:1px solid var(--border-color);font-size:0.85rem;">
      ${bdEscapeHtml(b.name)} — ${b.email_type} — ${b.completed ? 'Completed' : b.sending ? 'Sending' : 'Draft'}
    </div>
  `).join('') || '<p class="bd-muted">No batches yet.</p>';

  const upcoming = prospects.filter((p) => p.fu1_eligible || p.fu2_eligible).slice(0, 10);
  document.getElementById('dashUpcoming').innerHTML = upcoming.map((p) => `
    <div style="padding:0.3rem 0;border-bottom:1px solid var(--border-color);font-size:0.85rem;">
      ${bdEscapeHtml(p.company)} — ${p.fu2_eligible ? 'Follow-up 2' : 'Follow-up 1'} recommended
    </div>
  `).join('') || '<p class="bd-muted">Nothing due.</p>';
}
