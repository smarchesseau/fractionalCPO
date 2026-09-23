let bdActivityRows = [];

async function bdLoadActivity() {
  const { data, error } = await sb.from('bd_activity')
    .select('*, bd_prospects(company), bd_batches(name)')
    .order('occurred_at', { ascending: false })
    .limit(500);
  if (error) { bdToast('Failed to load activity: ' + error.message, 'error'); return; }
  bdActivityRows = data;
  document.getElementById('activityTbody').innerHTML = data.map((a) => `
    <tr>
      <td>${bdFormatDate(a.occurred_at)}</td>
      <td>${bdEscapeHtml(a.action)}</td>
      <td>${bdEscapeHtml(a.bd_prospects?.company || '—')}</td>
      <td>${bdEscapeHtml(a.bd_batches?.name || '—')}</td>
      <td style="font-size:0.8rem;">${bdEscapeHtml(JSON.stringify(a.details || {}))}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="bd-muted">No activity yet.</td></tr>';
}

document.getElementById('exportActivityBtn').addEventListener('click', () => {
  bdDownloadCsv('bd_activity.csv', ['occurred_at', 'action', 'company', 'batch', 'details'], bdActivityRows.map((a) => ({
    occurred_at: a.occurred_at,
    action: a.action,
    company: a.bd_prospects?.company || '',
    batch: a.bd_batches?.name || '',
    details: JSON.stringify(a.details || {}),
  })));
});
