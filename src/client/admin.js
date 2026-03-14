// ── Auth helpers ──
function getToken() {
  try { return localStorage.getItem('kwangdong_admin_token') || ''; } catch { return ''; }
}
function setToken(token) {
  try { localStorage.setItem('kwangdong_admin_token', token); } catch { /* ignore */ }
}
function clearToken() {
  try { localStorage.removeItem('kwangdong_admin_token'); } catch { /* ignore */ }
}

function authFetch(url, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return fetch(url, { ...options, headers });
}

// ── DOM refs ──
const loginSection = document.querySelector('#login-section');
const adminSection = document.querySelector('#admin-section');
const passwordInput = document.querySelector('#password-input');
const loginBtn = document.querySelector('#login-btn');
const loginError = document.querySelector('#login-error');
const logoutBtn = document.querySelector('#logout-btn');
const submissionList = document.querySelector('#submission-list');
const adminFilter = document.querySelector('#admin-filter');

// ── Login ──
loginBtn.addEventListener('click', handleLogin);
passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});

async function handleLogin() {
  loginError.textContent = '';
  const password = passwordInput.value.trim();
  if (!password) {
    loginError.textContent = '비밀번호를 입력해주세요.';
    return;
  }
  loginBtn.disabled = true;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) {
      loginError.textContent = data.error || '로그인에 실패했어요.';
      loginBtn.disabled = false;
      return;
    }
    setToken(data.token);
    showAdmin();
  } catch {
    loginError.textContent = '서버에 연결할 수 없어요.';
    loginBtn.disabled = false;
  }
}

// ── Logout ──
logoutBtn.addEventListener('click', () => {
  clearToken();
  showLogin();
});

function showLogin() {
  loginSection.classList.remove('hidden');
  adminSection.classList.add('hidden');
  logoutBtn.classList.add('hidden');
  loginBtn.disabled = false;
  passwordInput.value = '';
  loginError.textContent = '';
  stopPolling();
}

async function showAdmin() {
  loginSection.classList.add('hidden');
  adminSection.classList.remove('hidden');
  logoutBtn.classList.remove('hidden');
  await loadSettings();
  await loadAdminData();
  renderAllSettings();
}

// ── Verify token on load ──
async function init() {
  const token = getToken();
  if (!token) { showLogin(); return; }
  try {
    const res = await authFetch('/api/admin/verify');
    if (res.ok) {
      showAdmin();
    } else {
      clearToken();
      showLogin();
    }
  } catch {
    showLogin();
  }
}

// ── Admin data ──
let adminData = null;
let knownCount = 0;
let pollTimer = null;

async function loadAdminData() {
  try {
    const [bootstrapRes, submissionsRes] = await Promise.all([
      fetch('/api/bootstrap'),
      authFetch('/api/admin/submissions')
    ]);
    const bootstrap = await bootstrapRes.json();
    if (!submissionsRes.ok) {
      clearToken();
      showLogin();
      return;
    }
    const submissions = await submissionsRes.json();
    adminData = { ...bootstrap, submissions };
    knownCount = submissions.length;
    renderAdmin();
    startPolling();
  } catch {
    showToast('데이터를 불러올 수 없어요.', 'error');
  }
}

// ── Polling for new submissions ──
function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollNewSubmissions, 30000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollNewSubmissions() {
  try {
    const res = await authFetch('/api/admin/submissions');
    if (!res.ok) return;
    const submissions = await res.json();
    const newCount = submissions.length - knownCount;
    if (newCount > 0) {
      showNewSubmissionBanner(newCount);
    }
  } catch { /* ignore poll errors */ }
}

function showNewSubmissionBanner(count) {
  const banner = document.querySelector('#new-submission-banner');
  banner.innerHTML = `
    <div class="new-submission-banner">
      <span>\uD83D\uDD14 새 기록 ${count}건이 추가됐어요!</span>
      <button id="refresh-btn">새로고침</button>
    </div>
  `;
  banner.querySelector('#refresh-btn').addEventListener('click', async () => {
    banner.innerHTML = '';
    await loadAdminData();
  });
}

function hideNewSubmissionBanner() {
  const banner = document.querySelector('#new-submission-banner');
  if (banner) banner.innerHTML = '';
}

// ── Chart helpers ──
function renderBarChart(container, title, items) {
  // items: [{ label, value }] — already sorted
  const max = Math.max(...items.map((i) => i.value), 1);
  container.innerHTML = `
    <h2>${title}</h2>
    <div style="display:grid;gap:8px;">
      ${items.map((item) => {
        const pct = Math.round((item.value / max) * 100);
        return `
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="min-width:72px;font-size:13px;font-weight:600;text-align:right;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.label)}</span>
          <div style="flex:1;height:24px;background:var(--border);border-radius:6px;overflow:hidden;position:relative;">
            <div style="width:${pct}%;height:100%;background:var(--primary);border-radius:6px;transition:width 0.4s ease;"></div>
          </div>
          <span style="min-width:32px;font-size:13px;font-weight:700;color:var(--primary);">${item.value}</span>
        </div>`;
      }).join('')}
    </div>
  `;
}

function renderCharts() {
  if (!adminData) return;
  const { submissions } = adminData;

  // 1. Daily submission trend (last 7 days)
  const dailyCounts = {};
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyCounts[key] = 0;
  }
  submissions.forEach((s) => {
    const key = new Date(s.createdAt).toISOString().slice(0, 10);
    if (key in dailyCounts) dailyCounts[key]++;
  });
  const dailyItems = Object.entries(dailyCounts).map(([date, count]) => ({
    label: date.slice(5), // MM-DD
    value: count,
  }));
  renderBarChart(document.querySelector('#chart-daily'), '📈 일별 기록 추이', dailyItems);

  // 2. Researcher contribution
  const researchers = {};
  submissions.forEach((s) => {
    const name = s.researcher.name;
    researchers[name] = (researchers[name] || 0) + 1;
  });
  const researcherItems = Object.entries(researchers)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ label: name, value: count }));
  renderBarChart(document.querySelector('#chart-researcher'), '👥 조사자별 기여도', researcherItems);

  // 3. Area distribution
  const areaCounts = {};
  submissions.forEach((s) => {
    const area = s.assignment?.currentArea;
    if (area) areaCounts[area] = (areaCounts[area] || 0) + 1;
  });
  const areaItems = Object.entries(areaCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([area, count]) => ({ label: area, value: count }));
  renderBarChart(document.querySelector('#chart-area'), '📍 지역별 분포', areaItems);

  // 4. Data quality metrics
  const total = submissions.length;
  const withPrice = submissions.filter((s) => (s.prices || []).length > 0).length;
  const priceRate = total ? Math.round((withPrice / total) * 100) : 0;
  const totalPrices = submissions.reduce((sum, s) => sum + (s.prices || []).length, 0);
  const avgPrices = total ? (totalPrices / total).toFixed(1) : '0';
  const withPhoto = submissions.filter((s) => s.photo).length;
  const photoRate = total ? Math.round((withPhoto / total) * 100) : 0;

  document.querySelector('#chart-quality').innerHTML = `
    <h2>📊 데이터 품질</h2>
    <div style="display:grid;gap:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:var(--radius-sm);">
        <span style="font-size:14px;font-weight:600;">가격 입력률</span>
        <span style="font-size:18px;font-weight:800;color:var(--primary);">${priceRate}%</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:var(--radius-sm);">
        <span style="font-size:14px;font-weight:600;">평균 가격 입력 수</span>
        <span style="font-size:18px;font-weight:800;color:var(--primary);">${avgPrices}개/건</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:var(--radius-sm);">
        <span style="font-size:14px;font-weight:600;">사진 첨부율</span>
        <span style="font-size:18px;font-weight:800;color:var(--primary);">${photoRate}%</span>
      </div>
    </div>
  `;
}

function renderAdmin() {
  if (!adminData) return;
  const { submissions, areas } = adminData;

  // Stats
  const total = submissions.length;
  const today = new Date().toDateString();
  const todayCount = submissions.filter((s) => new Date(s.createdAt).toDateString() === today).length;
  const researchers = {};
  const researcherLastActivity = {};
  submissions.forEach((s) => {
    const name = s.researcher.name;
    researchers[name] = (researchers[name] || 0) + 1;
    const ts = new Date(s.createdAt).getTime();
    if (!researcherLastActivity[name] || ts > researcherLastActivity[name]) {
      researcherLastActivity[name] = ts;
    }
  });
  const uniqueResearchers = Object.keys(researchers).length;
  const areaCounts = {};
  submissions.forEach((s) => {
    const area = s.assignment?.currentArea;
    if (area) areaCounts[area] = (areaCounts[area] || 0) + 1;
  });
  const coveredAreas = Object.keys(areaCounts).length;

  document.querySelector('#admin-stats').innerHTML = `
    <div class="quick-stat"><span class="qs-icon">🏃</span><span class="qs-value">${total}</span><span class="qs-label">총 기록</span></div>
    <div class="quick-stat"><span class="qs-icon">📅</span><span class="qs-value">${todayCount}</span><span class="qs-label">오늘</span></div>
    <div class="quick-stat"><span class="qs-icon">👤</span><span class="qs-value">${uniqueResearchers}</span><span class="qs-label">조사자</span></div>
    <div class="quick-stat"><span class="qs-icon">📍</span><span class="qs-value">${coveredAreas}/${areas.length}</span><span class="qs-label">지역</span></div>
  `;

  // Researcher stats with last activity
  const researcherStats = document.querySelector('#researcher-stats');
  const sortedResearchers = Object.entries(researchers).sort((a, b) => b[1] - a[1]);
  researcherStats.innerHTML = `
    <h2>조사자별 현황 👤</h2>
    <div class="area-cards">
      ${sortedResearchers.map(([name, count], idx) => {
        const lastDate = new Date(researcherLastActivity[name]).toLocaleDateString('ko-KR');
        const rank = idx + 1;
        return `
        <div class="area-card">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:2px;">#${rank}</div>
          <div class="area-name">${escapeHtml(name)}</div>
          <div class="area-count">${count}건</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">최근 ${lastDate}</div>
        </div>
      `;
      }).join('')}
    </div>
    <h3 style="margin-top:16px;">지역별 현황</h3>
    <div class="area-cards">
      ${areas.map((area) => `
        <div class="area-card">
          <div class="area-name">${escapeHtml(area)}</div>
          <div class="area-count">${areaCounts[area] || 0}건</div>
        </div>
      `).join('')}
    </div>
  `;

  // Filters
  const researcherNames = Object.keys(researchers).sort();
  adminFilter.innerHTML = `
    <select id="filter-date">
      <option value="">전체 기간</option>
      <option value="today">오늘</option>
      <option value="7days">최근 7일</option>
      <option value="30days">최근 30일</option>
    </select>
    <select id="filter-researcher">
      <option value="">전체 조사자</option>
      ${researcherNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}
    </select>
    <select id="filter-area">
      <option value="">전체 지역</option>
      ${areas.map((a) => `<option value="${a}">${a}</option>`).join('')}
    </select>
    <input type="text" id="filter-store" placeholder="매장명 검색" />
  `;
  const filterDate = adminFilter.querySelector('#filter-date');
  const filterResearcher = adminFilter.querySelector('#filter-researcher');
  const filterArea = adminFilter.querySelector('#filter-area');
  const filterStore = adminFilter.querySelector('#filter-store');
  const doFilter = () => renderSubmissionList(
    filterDate.value,
    filterResearcher.value,
    filterArea.value,
    filterStore.value
  );
  filterDate.addEventListener('change', doFilter);
  filterResearcher.addEventListener('change', doFilter);
  filterArea.addEventListener('change', doFilter);
  filterStore.addEventListener('input', doFilter);
  renderSubmissionList('', '', '', '');
  renderCharts();
  renderWeekCompare();
}

function applyDateFilter(submissions, dateFilter) {
  if (!dateFilter) return submissions;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (dateFilter === 'today') {
    return submissions.filter((s) => new Date(s.createdAt) >= startOfToday);
  }
  if (dateFilter === '7days') {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() - 7);
    return submissions.filter((s) => new Date(s.createdAt) >= d);
  }
  if (dateFilter === '30days') {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() - 30);
    return submissions.filter((s) => new Date(s.createdAt) >= d);
  }
  return submissions;
}

function renderSubmissionList(dateFilter, researcherFilter, areaFilter, storeFilter) {
  if (!adminData) return;
  const { submissions, areas, products } = adminData;
  let filtered = submissions;

  filtered = applyDateFilter(filtered, dateFilter);

  if (researcherFilter) {
    filtered = filtered.filter((s) => s.researcher.name === researcherFilter);
  }
  if (areaFilter) {
    filtered = filtered.filter((s) => s.assignment?.currentArea === areaFilter);
  }
  if (storeFilter) {
    const q = storeFilter.toLowerCase();
    filtered = filtered.filter((s) => s.survey.storeName.toLowerCase().includes(q));
  }

  submissionList.innerHTML = filtered.length
    ? filtered.map((sub) => {
        const priceRows = (sub.prices || []).map((p) =>
          `<tr><td>${escapeHtml(p.productLabel)}</td><td>${escapeHtml(p.size)}</td><td style="text-align:right;">\u20A9${Number(p.price).toLocaleString()}</td></tr>`
        ).join('');
        const gps = sub.gps || sub.location;
        const gpsText = gps ? `${gps.lat?.toFixed(5)}, ${gps.lng?.toFixed(5)}` : '-';

        return `
      <article class="submission-card" data-id="${sub.id}">
        <div class="sub-header" style="cursor:pointer;" data-toggle="${sub.id}">
          <span class="store-name">${escapeHtml(sub.survey.storeName)}</span>
          <span class="sub-date">${new Date(sub.createdAt).toLocaleDateString('ko-KR')}</span>
        </div>
        <div class="sub-meta">
          ${escapeHtml(sub.researcher.name)} \u00B7 ${escapeHtml(sub.researcher.residenceArea)} \u2192 <strong>${escapeHtml(sub.assignment?.currentArea || '')}</strong>
        </div>
        <div class="sub-meta">${escapeHtml(sub.survey.region)} \u00B7 ${escapeHtml(sub.survey.storeType)} \u00B7 POS ${sub.survey.posCount}</div>
        <div class="sub-detail hidden" id="detail-${sub.id}">
          ${sub.survey.displayLocation ? `<div class="sub-meta" style="margin-top:6px;">진열위치: ${escapeHtml(sub.survey.displayLocation)}</div>` : ''}
          ${priceRows ? `
          <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px;">
            <thead><tr style="border-bottom:1.5px solid var(--border);text-align:left;">
              <th style="padding:6px 4px;">제품</th><th style="padding:6px 4px;">사이즈</th><th style="padding:6px 4px;text-align:right;">가격</th>
            </tr></thead>
            <tbody>${priceRows}</tbody>
          </table>` : '<div class="sub-meta" style="margin-top:8px;">가격 데이터 없음</div>'}
          ${sub.photo ? `<img class="sub-photo" src="${sub.photo.url}" alt="${escapeHtml(sub.survey.storeName)}" />` : ''}
          ${sub.notes ? `<div class="sub-meta" style="margin-top:6px;">메모: ${escapeHtml(sub.notes)}</div>` : ''}
          <div class="sub-meta" style="margin-top:6px;">GPS: ${gpsText}</div>
          <div class="sub-actions">
            <select data-submission-id="${sub.id}">
              ${areas.map((a) => `<option value="${a}" ${a === sub.assignment?.currentArea ? 'selected' : ''}>${a}</option>`).join('')}
            </select>
            <button data-action="override" data-submission-id="${sub.id}">지역 변경</button>
            <button data-action="delete" data-submission-id="${sub.id}" class="btn-danger-sm">삭제</button>
          </div>
        </div>
      </article>
    `;
      }).join('')
    : '<div class="notice">기록이 없어요.</div>';

  // Toggle detail
  submissionList.querySelectorAll('[data-toggle]').forEach((header) => {
    header.addEventListener('click', () => {
      const detail = document.querySelector(`#detail-${header.dataset.toggle}`);
      if (detail) detail.classList.toggle('hidden');
    });
  });

  submissionList.querySelectorAll('[data-action="override"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const select = submissionList.querySelector(`select[data-submission-id="${button.dataset.submissionId}"]`);
      const response = await fetch('/api/assignments/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submissionId: button.dataset.submissionId,
          assignedArea: select.value,
          reason: 'Admin override',
          adminName: 'Admin'
        })
      });
      if (response.ok) {
        showToast('지역이 변경되었어요.');
        await loadAdminData();
      }
    });
  });

  submissionList.querySelectorAll('[data-action="delete"]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('정말 삭제할까요?')) return;
      const response = await authFetch('/api/submissions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId: button.dataset.submissionId })
      });
      if (response.ok) {
        showToast('삭제되었어요.');
        await loadAdminData();
      } else {
        showToast('삭제에 실패했어요.', 'error');
      }
    });
  });
}

// ── CSV Export ──
function formatDateCSV(dateStr) {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

document.querySelector('#csv-btn').addEventListener('click', () => {
  if (!adminData) return;
  const { submissions, products } = adminData;

  const priceHeaders = [];
  for (const product of products) {
    for (const size of product.sizes) {
      priceHeaders.push(`${product.label} ${size}`);
    }
  }

  const headers = ['제출일시', '조사자', '거주지역', '조사지역', '매장유형', '매장명', 'POS대수', '진열위치', ...priceHeaders, '메모', '위도', '경도'];

  const rows = submissions.map((sub) => {
    const priceMap = {};
    (sub.prices || []).forEach((p) => {
      priceMap[`${p.productLabel} ${p.size}`] = p.price;
    });
    const priceCols = priceHeaders.map((h) => {
      const v = priceMap[h];
      if (v === undefined || v === null) return '';
      return String(v).replace(/[^0-9]/g, '');
    });
    const gps = sub.gps || sub.location;
    return [
      formatDateCSV(sub.createdAt),
      sub.researcher.name,
      sub.researcher.residenceArea,
      sub.assignment?.currentArea || '',
      sub.survey.storeType,
      sub.survey.storeName,
      sub.survey.posCount,
      sub.survey.displayLocation || '',
      ...priceCols,
      sub.notes || '',
      gps?.lat ?? '',
      gps?.lng ?? ''
    ];
  });

  const csvContent = [headers, ...rows].map((row) =>
    row.map((cell) => {
      const str = String(cell);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',')
  ).join('\r\n');

  const bom = '\uFEFF';
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  const count = submissions.length;
  a.href = url;
  a.download = `ionroad-export-${count}\uAC74-${dateStr}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV 파일이 다운로드되었어요.');
});

// ── Backup ──
document.querySelector('#backup-btn').addEventListener('click', async () => {
  try {
    const res = await authFetch('/api/backup');
    if (!res.ok) {
      showToast('백업에 실패했어요.', 'error');
      return;
    }
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    a.href = url;
    a.download = `ionroad-backup-${dateStr}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('백업 파일이 다운로드되었어요.');
  } catch {
    showToast('백업에 실패했어요.', 'error');
  }
});

// ── Helpers ──
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(message, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type || 'success'}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ── Print ──
document.querySelector('#print-btn').addEventListener('click', () => {
  const title = document.querySelector('#admin-title');
  title.setAttribute('data-print-date', new Date().toLocaleDateString('ko-KR'));
  window.print();
});

// ── Week comparison ──
function renderWeekCompare() {
  if (!adminData) return;
  const section = document.querySelector('#week-compare-section');
  const { submissions } = adminData;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = startOfToday.getDay() || 7; // Mon=1 ... Sun=7

  const thisWeekStart = new Date(startOfToday);
  thisWeekStart.setDate(thisWeekStart.getDate() - (dayOfWeek - 1));

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = new Date(thisWeekStart);

  const thisWeekCount = submissions.filter((s) => new Date(s.createdAt) >= thisWeekStart).length;
  const lastWeekCount = submissions.filter((s) => {
    const d = new Date(s.createdAt);
    return d >= lastWeekStart && d < lastWeekEnd;
  }).length;

  const delta = thisWeekCount - lastWeekCount;
  let deltaText, deltaClass;
  if (delta > 0) {
    deltaText = `\u25B2 +${delta}\uAC74`;
    deltaClass = 'positive';
  } else if (delta < 0) {
    deltaText = `\u25BC ${delta}\uAC74`;
    deltaClass = 'negative';
  } else {
    deltaText = '\u2014 \uBCC0\uB3D9 \uC5C6\uC74C';
    deltaClass = 'neutral';
  }

  section.innerHTML = `
    <h2>\uD83D\uDCC5 \uC8FC\uAC04 \uBE44\uAD50</h2>
    <div class="week-compare">
      <div class="week-compare-item">
        <span class="wc-label">\uC9C0\uB09C\uC8FC</span>
        <span class="wc-value">${lastWeekCount}</span>
        <span class="wc-label">\uAC74</span>
      </div>
      <div class="week-compare-item">
        <span class="wc-label">\uC774\uBC88\uC8FC</span>
        <span class="wc-value">${thisWeekCount}</span>
        <span class="wc-label">\uAC74</span>
      </div>
    </div>
    <div class="week-compare-delta ${deltaClass}">${deltaText}</div>
  `;
}

// ── Settings management ──
let settingsData = { customAreas: null, customProducts: null, customStoreTypes: null };

async function loadSettings() {
  try {
    const res = await authFetch('/api/admin/settings');
    if (!res.ok) return;
    settingsData = await res.json();
  } catch { /* ignore */ }
}

async function saveSetting(key, value) {
  const res = await authFetch('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value })
  });
  if (!res.ok) {
    showToast('설정 저장에 실패했어요.', 'error');
    return false;
  }
  showToast('설정이 저장되었어요.');
  return true;
}

function getActiveAreas() {
  return settingsData.customAreas || adminData?.areas || [];
}

function getActiveStoreTypes() {
  return settingsData.customStoreTypes || adminData?.storeTypeTemplates || [];
}

function getActiveProducts() {
  return settingsData.customProducts || adminData?.products || [];
}

function renderSettingsAreas() {
  const areas = getActiveAreas();
  const container = document.querySelector('#area-chips');
  container.innerHTML = areas.map((area) =>
    `<span class="chip">${escapeHtml(area)}<button data-remove-area="${escapeHtml(area)}" title="삭제">\u2715</button></span>`
  ).join('');

  container.querySelectorAll('[data-remove-area]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const areaName = btn.dataset.removeArea;
      const updated = getActiveAreas().filter((a) => a !== areaName);
      if (await saveSetting('customAreas', updated)) {
        settingsData.customAreas = updated;
        renderSettingsAreas();
        await loadAdminData();
      }
    });
  });
}

function renderSettingsStoreTypes() {
  const types = getActiveStoreTypes();
  const container = document.querySelector('#store-type-chips');
  container.innerHTML = types.map((t) =>
    `<span class="chip">${escapeHtml(t.label)} (POS ${t.defaultPosCount})<button data-remove-st="${escapeHtml(t.id)}" title="삭제">\u2715</button></span>`
  ).join('');

  container.querySelectorAll('[data-remove-st]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const stId = btn.dataset.removeSt;
      const updated = getActiveStoreTypes().filter((t) => t.id !== stId);
      if (await saveSetting('customStoreTypes', updated)) {
        settingsData.customStoreTypes = updated;
        renderSettingsStoreTypes();
        await loadAdminData();
      }
    });
  });
}

function renderSettingsProducts() {
  const products = getActiveProducts();
  const container = document.querySelector('#product-list-manage');
  container.innerHTML = products.map((p) => `
    <div class="product-card" data-pid="${escapeHtml(p.id)}">
      <div class="product-header">
        <span><span class="product-name">${escapeHtml(p.label)}</span> <span class="product-brand">(${escapeHtml(p.brand)})</span></span>
        <button data-remove-product="${escapeHtml(p.id)}" style="background:none;border:none;cursor:pointer;color:var(--error);font-weight:700;">삭제</button>
      </div>
      <div class="chip-list">
        ${p.sizes.map((s) => `<span class="size-chip">${escapeHtml(s)}<button data-remove-size="${escapeHtml(p.id)}|${escapeHtml(s)}">\u2715</button></span>`).join('')}
      </div>
      <div class="add-size-row">
        <input type="text" placeholder="새 사이즈" data-size-input="${escapeHtml(p.id)}" />
        <button data-add-size="${escapeHtml(p.id)}" class="btn btn-primary">+</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-remove-product]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pid = btn.dataset.removeProduct;
      const updated = getActiveProducts().filter((p) => p.id !== pid);
      if (await saveSetting('customProducts', updated)) {
        settingsData.customProducts = updated;
        renderSettingsProducts();
        await loadAdminData();
      }
    });
  });

  container.querySelectorAll('[data-remove-size]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const [pid, size] = btn.dataset.removeSize.split('|');
      const updated = getActiveProducts().map((p) =>
        p.id === pid ? { ...p, sizes: p.sizes.filter((s) => s !== size) } : p
      );
      if (await saveSetting('customProducts', updated)) {
        settingsData.customProducts = updated;
        renderSettingsProducts();
        await loadAdminData();
      }
    });
  });

  container.querySelectorAll('[data-add-size]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pid = btn.dataset.addSize;
      const input = container.querySelector(`[data-size-input="${pid}"]`);
      const size = input.value.trim();
      if (!size) return;
      const updated = getActiveProducts().map((p) =>
        p.id === pid ? { ...p, sizes: [...p.sizes, size] } : p
      );
      if (await saveSetting('customProducts', updated)) {
        settingsData.customProducts = updated;
        renderSettingsProducts();
        await loadAdminData();
      }
    });
  });
}

function renderAllSettings() {
  renderSettingsAreas();
  renderSettingsStoreTypes();
  renderSettingsProducts();
}

// Area add button
document.querySelector('#add-area-btn').addEventListener('click', async () => {
  const input = document.querySelector('#new-area-input');
  const name = input.value.trim();
  if (!name) return;
  const updated = [...getActiveAreas(), name];
  if (await saveSetting('customAreas', updated)) {
    settingsData.customAreas = updated;
    input.value = '';
    renderSettingsAreas();
    await loadAdminData();
  }
});

// Store type add button
document.querySelector('#add-store-type-btn').addEventListener('click', async () => {
  const labelInput = document.querySelector('#new-store-type-label');
  const posInput = document.querySelector('#new-store-type-pos');
  const label = labelInput.value.trim();
  if (!label) return;
  const defaultPosCount = Number(posInput.value) || 1;
  const id = label.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-');
  const updated = [...getActiveStoreTypes(), { id, label, defaultPosCount }];
  if (await saveSetting('customStoreTypes', updated)) {
    settingsData.customStoreTypes = updated;
    labelInput.value = '';
    posInput.value = '1';
    renderSettingsStoreTypes();
    await loadAdminData();
  }
});

// Product add button
document.querySelector('#add-product-btn').addEventListener('click', async () => {
  const labelInput = document.querySelector('#new-product-label');
  const brandInput = document.querySelector('#new-product-brand');
  const sizesInput = document.querySelector('#new-product-sizes');
  const label = labelInput.value.trim();
  if (!label) return;
  const brand = brandInput.value;
  const sizes = sizesInput.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (sizes.length === 0) {
    showToast('사이즈를 하나 이상 입력해주세요.', 'error');
    return;
  }
  const id = label.toLowerCase().replace(/[^a-z0-9가-힣]/g, '-').replace(/-+/g, '-');
  const updated = [...getActiveProducts(), { id, label, brand, sizes }];
  if (await saveSetting('customProducts', updated)) {
    settingsData.customProducts = updated;
    labelInput.value = '';
    sizesInput.value = '';
    renderSettingsProducts();
    await loadAdminData();
  }
});

// ── Init ──
init();
