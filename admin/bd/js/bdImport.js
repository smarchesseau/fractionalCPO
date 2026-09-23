const BD_IMPORT_TARGET_FIELDS = [
  { key: 'company', label: 'Company', required: true },
  { key: 'contact_name', label: 'Contact name' },
  { key: 'email', label: 'Email', required: true },
  { key: 'location', label: 'Location' },
  { key: 'employee_range', label: 'Estimated employees' },
  { key: 'size_confidence', label: 'Size confidence' },
  { key: 'sector', label: 'Sector' },
  { key: 'target_decision_maker', label: 'Target decision-maker' },
  { key: 'priority', label: 'Priority' },
  { key: 'email_verification', label: 'Email verification' },
  { key: 'source_url', label: 'Source' },
  { key: 'pain_points', label: 'Likely pain points' },
  { key: 'automation_opportunities', label: 'Automation opportunities' },
  { key: 'initial_email_raw', label: 'Personalized initial email', required: true },
  { key: 'followup1_raw', label: 'Follow-up 1' },
  { key: 'followup2_raw', label: 'Follow-up 2' },
];

// Hints are written unaccented -- bdNormalizeHeader() strips diacritics from
// actual column headers before comparing, so "Ubicación" still matches
// "ubicacion" etc. Spanish terms included since imports commonly use them.
const BD_IMPORT_HEADER_HINTS = {
  company: ['company', 'empresa'],
  contact_name: ['contact name', 'nombre de contacto', 'contacto', 'contact', 'nombre'],
  email: ['public email', 'correo publico', 'correo electronico', 'email', 'correo'],
  location: ['location', 'ubicacion', 'localizacion'],
  employee_range: ['estimated employees', 'empleados estimados', 'numero de empleados', 'employees', 'empleados'],
  size_confidence: ['size confidence', 'confianza de tamano', 'confianza tamano'],
  sector: ['sector'],
  target_decision_maker: ['target decision-maker', 'decision maker', 'decision-maker', 'responsable de decision', 'tomador de decisiones', 'decisor'],
  priority: ['priority', 'prioridad'],
  email_verification: ['email verification', 'verificacion de correo', 'verificacion de email'],
  source_url: ['source', 'fuente'],
  pain_points: ['likely pain points', 'puntos de dolor probables', 'puntos de dolor', 'pain points'],
  automation_opportunities: ['automation opportunities', 'oportunidades de automatizacion'],
  initial_email_raw: ['personalized initial email', 'correo inicial personalizado', 'correo inicial', 'initial email', 'email inicial'],
  followup1_raw: ['follow-up 1', 'follow up 1', 'followup 1', 'seguimiento 1'],
  followup2_raw: ['follow-up 2', 'follow up 2', 'followup 2', 'seguimiento 2'],
};

let bdImportHeaders = [];
let bdImportRawRows = [];
let bdImportMapping = {};
let bdImportPreviewResults = [];
let bdImportBuiltRows = [];

function bdNormalizeHeader(str) {
  return String(str ?? '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // strip accents (á->a, ñ->n, ...)
}

function bdGuessHeaderFor(fieldKey, headers) {
  const hints = BD_IMPORT_HEADER_HINTS[fieldKey] || [];
  for (const hint of hints) {
    const found = headers.find((h) => bdNormalizeHeader(h) === hint);
    if (found) return found;
  }
  for (const hint of hints) {
    const found = headers.find((h) => bdNormalizeHeader(h).includes(hint));
    if (found) return found;
  }
  return '';
}

function bdResetImport() {
  bdImportHeaders = [];
  bdImportRawRows = [];
  bdImportMapping = {};
  bdImportPreviewResults = [];
  bdImportBuiltRows = [];
  document.getElementById('importFile').value = '';
  document.getElementById('importMappingCard').hidden = true;
  document.getElementById('importPreviewCard').hidden = true;
  document.getElementById('importResultsCard').hidden = true;
}

function bdParseImportFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'csv') {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        encoding: 'UTF-8',
        complete: (results) => resolve({ headers: results.meta.fields || [], rows: results.data }),
        error: (err) => reject(err),
      });
    });
  }
  if (ext === 'xlsx' || ext === 'xls') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const workbook = XLSX.read(e.target.result, { type: 'array' });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
          const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
          resolve({ headers, rows });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  }
  return Promise.reject(new Error('Unsupported file type. Use .csv, .xlsx or .xls.'));
}

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const { headers, rows } = await bdParseImportFile(file);
    bdImportRawRows = rows;
    bdImportHeaders = headers;
    bdRenderImportMapping();
  } catch (err) {
    bdToast('Failed to parse file: ' + (err.message || err), 'error');
  }
});

function bdRenderImportMapping() {
  const container = document.getElementById('importMappingContainer');
  container.innerHTML = `<div class="bd-field-row">${BD_IMPORT_TARGET_FIELDS.map((f) => {
    const guess = bdGuessHeaderFor(f.key, bdImportHeaders);
    bdImportMapping[f.key] = guess;
    return `
      <div class="bd-field-group">
        <label>${bdEscapeHtml(f.label)}${f.required ? ' *' : ''}</label>
        <select data-map-field="${f.key}">
          <option value="">— not mapped —</option>
          ${bdImportHeaders.map((h) => `<option value="${bdEscapeHtml(h)}" ${h === guess ? 'selected' : ''}>${bdEscapeHtml(h)}</option>`).join('')}
        </select>
      </div>`;
  }).join('')}</div>`;
  container.querySelectorAll('select[data-map-field]').forEach((sel) => {
    sel.addEventListener('change', () => { bdImportMapping[sel.dataset.mapField] = sel.value; });
  });
  document.getElementById('importMappingCard').hidden = false;
  document.getElementById('importPreviewCard').hidden = true;
  document.getElementById('importResultsCard').hidden = true;
}

function bdBuildRowsFromMapping() {
  return bdImportRawRows.map((raw, idx) => {
    const row = { row_index: idx };
    for (const f of BD_IMPORT_TARGET_FIELDS) {
      const header = bdImportMapping[f.key];
      row[f.key] = header ? (raw[header] ?? '') : '';
    }
    return row;
  });
}

document.getElementById('importPreviewBtn').addEventListener('click', async () => {
  const required = BD_IMPORT_TARGET_FIELDS.filter((f) => f.required);
  const missingMapping = required.filter((f) => !bdImportMapping[f.key]);
  if (missingMapping.length > 0) {
    bdToast('Map all required fields first: ' + missingMapping.map((f) => f.label).join(', '), 'error');
    return;
  }
  bdImportBuiltRows = bdBuildRowsFromMapping();
  const result = await bdCallFunction('bd-import', { dry_run: true, rows: bdImportBuiltRows });
  if (!result.ok) { bdToast('Preview failed: ' + (result.reason || result.detail || 'unknown error'), 'error'); return; }
  bdImportPreviewResults = result.results;
  bdRenderImportPreview(result.summary);
});

function bdRenderImportPreview(summary) {
  document.getElementById('importSummary').textContent =
    `${bdImportBuiltRows.length} rows: ${summary.created} to create, ${summary.updated} duplicates, ${summary.skipped} skipped, ${summary.invalid} invalid.`;

  const rows = bdImportPreviewResults;
  document.getElementById('importPreviewContainer').innerHTML = `
    <table class="bd-data-table">
      <thead><tr><th>Row</th><th>Status</th><th>Company</th><th>Email</th><th>Notes</th><th>Action</th></tr></thead>
      <tbody>
        ${rows.map((r) => {
          const built = bdImportBuiltRows[r.row_index];
          const isDuplicate = r.status === 'duplicate';
          const badge = r.status === 'invalid' ? 'red' : r.status === 'duplicate' ? 'amber' : r.status === 'will_create' ? 'green' : 'gray';
          return `<tr data-row-index="${r.row_index}">
            <td>${r.row_index + 1}</td>
            <td><span class="bd-badge bd-badge-${badge}">${bdEscapeHtml(r.status)}</span></td>
            <td>${bdEscapeHtml(built?.company)}</td>
            <td>${bdEscapeHtml(built?.email)}</td>
            <td>${[...(r.errors || []), ...(r.warnings || [])].map(bdEscapeHtml).join('<br>')}</td>
            <td>${isDuplicate ? `
              <select data-dup-action="${r.row_index}">
                <option value="skip">Skip</option>
                <option value="update">Update existing</option>
              </select>` : ''}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  document.getElementById('importPreviewCard').hidden = false;
}

document.getElementById('importConfirmBtn').addEventListener('click', () => {
  bdOpenConfirmModal(`Import ${bdImportBuiltRows.length} rows? No emails will be sent.`, async () => {
    const rowsWithActions = bdImportBuiltRows.map((row) => {
      const select = document.querySelector(`select[data-dup-action="${row.row_index}"]`);
      return select ? { ...row, duplicate_action: select.value } : row;
    });
    const result = await bdCallFunction('bd-import', { dry_run: false, rows: rowsWithActions });
    if (!result.ok) { bdToast('Import failed: ' + (result.reason || 'unknown error'), 'error'); return; }
    bdImportPreviewResults = result.results;
    document.getElementById('importResultsCard').hidden = false;
    document.getElementById('importResultsSummary').innerHTML = `
      <p>Created: ${result.summary.created} · Updated: ${result.summary.updated} · Skipped: ${result.summary.skipped} · Invalid: ${result.summary.invalid}</p>`;
    document.getElementById('importPreviewCard').hidden = true;
    bdToast('Import complete.', 'success');
  }, { confirmLabel: 'Import' });
});

document.getElementById('importDownloadRejectedBtn').addEventListener('click', () => {
  const rejected = bdImportPreviewResults.filter((r) => r.status === 'invalid');
  if (rejected.length === 0) { bdToast('No rejected rows.'); return; }
  bdDownloadCsv('bd_rejected_rows.csv', ['row', 'company', 'email', 'errors'], rejected.map((r) => ({
    row: r.row_index + 1,
    company: bdImportBuiltRows[r.row_index]?.company,
    email: bdImportBuiltRows[r.row_index]?.email,
    errors: (r.errors || []).join('; '),
  })));
});
