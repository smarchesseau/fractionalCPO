let bdFu1Excluded = new Set();
let bdFu2Excluded = new Set();
let bdFu1Selected = new Set();
let bdFu2Selected = new Set();

async function bdLoadFollowups(stage) {
  const { data, error } = await sb.from('bd_prospect_eligibility').select('*');
  if (error) { bdToast('Failed to load: ' + error.message, 'error'); return; }

  if (stage === 'followup1') {
    const rows = data.filter((p) => p.fu1_eligible && !bdFu1Excluded.has(p.id));
    bdRenderFollowupTable('fu1', rows, 'initial_sent_at', 'days_since_initial', 'followup1_subject', 'followup1_body');
  } else {
    const rows = data.filter((p) => p.fu2_eligible && !bdFu2Excluded.has(p.id));
    bdRenderFollowupTable('fu2', rows, 'followup1_sent_at', 'days_since_followup1', 'followup2_subject', 'followup2_body');
  }
}

function bdRenderFollowupTable(prefix, rows, sentField, daysField, subjectField, bodyField) {
  const selected = prefix === 'fu1' ? bdFu1Selected : bdFu2Selected;
  const excluded = prefix === 'fu1' ? bdFu1Excluded : bdFu2Excluded;
  document.getElementById(`${prefix}Tbody`).innerHTML = rows.map((p) => {
    const ctx = bdBuildTemplateContext(p);
    const { rendered: subj } = bdRenderTemplate(p[subjectField], ctx);
    const { rendered: body } = bdRenderTemplate(p[bodyField], ctx);
    return `<tr>
      <td><input type="checkbox" class="${prefix}-select" data-id="${p.id}" ${selected.has(p.id) ? 'checked' : ''}></td>
      <td><a href="#" data-open="${p.id}">${bdEscapeHtml(p.company)}</a></td>
      <td>${bdEscapeHtml(p.contact_name || '—')}</td>
      <td>${bdFormatDate(p[sentField])}</td>
      <td>${p[daysField] ?? '—'}</td>
      <td>${bdStatusBadge(p.status)}</td>
      <td><details><summary>${bdEscapeHtml(subj)}</summary><div class="bd-email-preview">${bdEscapeHtml(body)}</div></details></td>
      <td>
        <button class="bd-btn bd-btn-sm" data-open="${p.id}">Edit</button>
        <button class="bd-btn bd-btn-sm" data-exclude="${p.id}">Exclude</button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" class="bd-muted">No prospects currently eligible.</td></tr>`;

  document.querySelectorAll(`#${prefix}Tbody [data-open]`).forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); bdOpenProspectDrawer(el.dataset.open); }));
  document.querySelectorAll(`#${prefix}Tbody [data-exclude]`).forEach((el) => el.addEventListener('click', () => {
    excluded.add(el.dataset.exclude);
    selected.delete(el.dataset.exclude);
    bdLoadFollowups(prefix === 'fu1' ? 'followup1' : 'followup2');
  }));
  document.querySelectorAll(`.${prefix}-select`).forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) selected.add(cb.dataset.id); else selected.delete(cb.dataset.id);
    bdUpdateFollowupBar(prefix);
  }));
  bdUpdateFollowupBar(prefix);
}

function bdUpdateFollowupBar(prefix) {
  const selected = prefix === 'fu1' ? bdFu1Selected : bdFu2Selected;
  document.getElementById(`${prefix}SelectedCount`).textContent = `${selected.size} selected`;
}

document.getElementById('fu1SelectAll').addEventListener('change', (e) => {
  document.querySelectorAll('.fu1-select').forEach((cb) => { cb.checked = e.target.checked; if (e.target.checked) bdFu1Selected.add(cb.dataset.id); else bdFu1Selected.delete(cb.dataset.id); });
  bdUpdateFollowupBar('fu1');
});
document.getElementById('fu2SelectAll').addEventListener('change', (e) => {
  document.querySelectorAll('.fu2-select').forEach((cb) => { cb.checked = e.target.checked; if (e.target.checked) bdFu2Selected.add(cb.dataset.id); else bdFu2Selected.delete(cb.dataset.id); });
  bdUpdateFollowupBar('fu2');
});

document.getElementById('fu1CreateBatchBtn').addEventListener('click', () => {
  if (bdFu1Selected.size === 0) { bdToast('Select at least one prospect first.'); return; }
  bdOpenAddToBatchModal([...bdFu1Selected], 'followup1');
});
document.getElementById('fu2CreateBatchBtn').addEventListener('click', () => {
  if (bdFu2Selected.size === 0) { bdToast('Select at least one prospect first.'); return; }
  bdOpenAddToBatchModal([...bdFu2Selected], 'followup2');
});
