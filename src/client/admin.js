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
}

async function showAdmin() {
  loginSection.classList.add('hidden');
  adminSection.classList.remove('hidden');
  logoutBtn.classList.remove('hidden');
  await loadAdminData();
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
    renderAdmin();
  } catch {
    showToast('데이터를 불러올 수 없어요.', 'error');
  }
}

function renderAdmin() {
  if (!adminData) return;
  const { submissions, areas } = adminData;

  // Stats
  const total = submissions.length;
  const today = new Date().toDateString();
  const todayCount = submissions.filter((s) => new Date(s.createdAt).toDateString() === today).length;
  const researchers = {};
  submissions.forEach((s) => {
    researchers[s.researcher.name] = (researchers[s.researcher.name] || 0) + 1;
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

  // Researcher stats
  const researcherStats = document.querySelector('#researcher-stats');
  const sortedResearchers = Object.entries(researchers).sort((a, b) => b[1] - a[1]);
  researcherStats.innerHTML = `
    <h2>조사자별 현황 👤</h2>
    <div class="area-cards">
      ${sortedResearchers.map(([name, count]) => `
        <div class="area-card">
          <div class="area-name">${escapeHtml(name)}</div>
          <div class="area-count">${count}건</div>
        </div>
      `).join('')}
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
  adminFilter.innerHTML = `
    <input type="text" id="filter-name" placeholder="이름 검색" />
    <select id="filter-area">
      <option value="">전체 지역</option>
      ${areas.map((a) => `<option value="${a}">${a}</option>`).join('')}
    </select>
  `;
  const filterName = adminFilter.querySelector('#filter-name');
  const filterArea = adminFilter.querySelector('#filter-area');
  const doFilter = () => renderSubmissionList(filterName.value, filterArea.value);
  filterName.addEventListener('input', doFilter);
  filterArea.addEventListener('change', doFilter);
  renderSubmissionList('', '');
}

function renderSubmissionList(nameFilter, areaFilter) {
  if (!adminData) return;
  const { submissions, areas } = adminData;
  let filtered = submissions;
  if (nameFilter) {
    const q = nameFilter.toLowerCase();
    filtered = filtered.filter((s) => s.researcher.name.toLowerCase().includes(q));
  }
  if (areaFilter) {
    filtered = filtered.filter((s) => s.assignment?.currentArea === areaFilter);
  }

  submissionList.innerHTML = filtered.length
    ? filtered.map((sub) => `
      <article class="submission-card">
        <div class="sub-header">
          <span class="store-name">${escapeHtml(sub.survey.storeName)}</span>
          <span class="sub-date">${new Date(sub.createdAt).toLocaleDateString('ko-KR')}</span>
        </div>
        <div class="sub-meta">
          ${escapeHtml(sub.researcher.name)} \u00B7 ${escapeHtml(sub.researcher.residenceArea)} \u2192 <strong>${escapeHtml(sub.assignment?.currentArea || '')}</strong>
        </div>
        <div class="sub-meta">${escapeHtml(sub.survey.region)} \u00B7 ${escapeHtml(sub.survey.storeType)} \u00B7 POS ${sub.survey.posCount}</div>
        <div class="sub-prices">${(sub.prices || []).map((p) => `${p.productLabel} ${p.size} \u20A9${p.price}`).join(', ')}</div>
        ${sub.photo ? `<img class="sub-photo" src="${sub.photo.url}" alt="${escapeHtml(sub.survey.storeName)}" />` : ''}
        <div class="sub-actions">
          <select data-submission-id="${sub.id}">
            ${areas.map((a) => `<option value="${a}" ${a === sub.assignment?.currentArea ? 'selected' : ''}>${a}</option>`).join('')}
          </select>
          <button data-action="override" data-submission-id="${sub.id}">지역 변경</button>
          <button data-action="delete" data-submission-id="${sub.id}" class="btn-danger-sm">삭제</button>
        </div>
      </article>
    `).join('')
    : '<div class="notice">기록이 없어요.</div>';

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

// ── Init ──
init();
