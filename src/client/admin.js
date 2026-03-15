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

// ── Accessibility: login error live region ──
if (loginError) {
  loginError.setAttribute('aria-live', 'polite');
  loginError.setAttribute('role', 'alert');
}

// ── Password visibility toggle ──
(function addPasswordToggle() {
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.textContent = '표시';
  toggleBtn.style.cssText = 'margin-left:8px;padding:6px 12px;background:none;border:1px solid var(--border,#ddd);border-radius:6px;cursor:pointer;font-size:.85rem;color:var(--text-muted,#666);';
  toggleBtn.setAttribute('aria-label', '비밀번호 표시/숨기기');
  toggleBtn.addEventListener('click', () => {
    const isText = passwordInput.type === 'text';
    passwordInput.type = isText ? 'password' : 'text';
    toggleBtn.textContent = isText ? '표시' : '숨김';
    passwordInput.focus();
  });
  passwordInput.parentNode.insertBefore(toggleBtn, passwordInput.nextSibling);
})();

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
  loginBtn.textContent = '확인 중...';
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
      loginBtn.textContent = '로그인';
      return;
    }
    setToken(data.token);
    showAdmin();
  } catch {
    loginError.textContent = '서버에 연결할 수 없어요.';
    loginBtn.disabled = false;
    loginBtn.textContent = '로그인';
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

// ── Tab switching ──
(function initAdminTabs() {
  const tabs = [...document.querySelectorAll('.admin-tab')];
  const tabContainer = tabs[0]?.parentElement;
  if (tabContainer) tabContainer.setAttribute('role', 'tablist');
  tabs.forEach((tab) => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
    const panelId = `tab-${tab.dataset.tab}`;
    tab.setAttribute('aria-controls', panelId);
    const panel = document.querySelector(`#${panelId}`);
    if (panel) {
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id || panelId + '-tab');
    }
    tab.addEventListener('click', () => {
      tabs.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.admin-tab-panel').forEach((p) => p.style.display = 'none');
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const activePanel = document.querySelector(`#tab-${tab.dataset.tab}`);
      if (activePanel) activePanel.style.display = 'block';
    });
    tab.addEventListener('keydown', (e) => {
      const idx = tabs.indexOf(tab);
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const next = tabs[(idx + 1) % tabs.length];
        next.focus();
        next.click();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
        prev.focus();
        prev.click();
      }
    });
  });
})();

// ── Admin data ──
let adminData = null;
let knownCount = 0;
let pollTimer = null;

// ── Submission list state ──
let submissionPage = 1;
const SUBMISSION_PAGE_SIZE = 20;
let currentFilters = { date: '', researcher: '', area: '', store: '' };
let lastFilteredCount = 0;
let bulkSelectMode = false;
const selectedSubmissionIds = new Set();

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

async function loadAdminData() {
  let loadingBanner = document.querySelector('#admin-loading-banner');
  if (!loadingBanner) {
    loadingBanner = document.createElement('div');
    loadingBanner.id = 'admin-loading-banner';
    loadingBanner.setAttribute('role', 'status');
    loadingBanner.setAttribute('aria-live', 'polite');
    loadingBanner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9990;background:var(--primary,#0066cc);color:#fff;text-align:center;padding:6px;font-size:.85rem;transition:opacity .3s;';
    loadingBanner.textContent = '⏳ 데이터 불러오는 중...';
    document.body.prepend(loadingBanner);
  }
  loadingBanner.style.opacity = '1';
  try {
    const [bootstrapRes, submissionsRes] = await Promise.all([
      fetch('/api/bootstrap'),
      authFetch('/api/admin/submissions')
    ]);
    const bootstrap = await bootstrapRes.json();
    if (!submissionsRes.ok) {
      clearToken();
      showLogin();
      loadingBanner.remove();
      return;
    }
    const submissions = await submissionsRes.json();
    adminData = { ...bootstrap, submissions };
    knownCount = submissions.length;
    renderAdmin();
    startPolling();
  } catch {
    showToast('데이터를 불러올 수 없어요.', 'error');
  } finally {
    loadingBanner.style.opacity = '0';
    setTimeout(() => loadingBanner.remove(), 300);
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
    <div class="new-submission-banner" role="status" aria-live="polite">
      <span>\uD83D\uDD14 새 기록 ${count}건이 추가됐어요!</span>
      <button id="refresh-btn">새로고침</button>
      <button id="dismiss-banner-btn" style="background:none;border:none;cursor:pointer;margin-left:4px;color:inherit;font-size:1rem;" aria-label="닫기">\u2715</button>
    </div>
  `;
  banner.querySelector('#refresh-btn').addEventListener('click', async () => {
    banner.innerHTML = '';
    await loadAdminData();
  });
  banner.querySelector('#dismiss-banner-btn').addEventListener('click', () => hideNewSubmissionBanner());
  // Auto-dismiss after 30 seconds
  setTimeout(() => hideNewSubmissionBanner(), 30000);
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

  // Researcher performance comparison
  const researcherStats = document.querySelector('#researcher-stats');
  const sortedResearchers = Object.entries(researchers).sort((a, b) => b[1] - a[1]);
  const maxCount = sortedResearchers[0]?.[1] || 1;

  // Per-researcher avg completeness
  const researcherCompleteness = {};
  submissions.forEach((s) => {
    const name = s.researcher.name;
    if (!researcherCompleteness[name]) researcherCompleteness[name] = { sum: 0, count: 0 };
    researcherCompleteness[name].sum += s.completenessScore ?? 0;
    researcherCompleteness[name].count += 1;
  });

  researcherStats.innerHTML = `
    <h2>조사자별 현황 👤</h2>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:.85rem;">
        <thead><tr style="border-bottom:2px solid var(--border,#eee);text-align:left;">
          <th style="padding:6px 8px;">순위</th>
          <th style="padding:6px 8px;">이름</th>
          <th style="padding:6px 8px;text-align:right;">기록</th>
          <th style="padding:6px 8px;">기여도</th>
          <th style="padding:6px 8px;text-align:right;">완료도</th>
          <th style="padding:6px 8px;">최근 활동</th>
        </tr></thead>
        <tbody>
          ${sortedResearchers.map(([name, count], idx) => {
    const lastDate = new Date(researcherLastActivity[name]).toLocaleDateString('ko-KR');
    const barPct = Math.round((count / maxCount) * 100);
    const rc = researcherCompleteness[name];
    const avgScore = rc ? Math.round(rc.sum / rc.count) : 0;
    const scoreColor = avgScore >= 80 ? 'var(--success,#27ae60)' : avgScore >= 50 ? '#f39c12' : 'var(--error,#e74c3c)';
    const medals = ['🥇', '🥈', '🥉'];
    return `
            <tr style="border-bottom:1px solid var(--border,#eee);">
              <td style="padding:8px;">${medals[idx] || `#${idx + 1}`}</td>
              <td style="padding:8px;font-weight:600;">${escapeHtml(name)}</td>
              <td style="padding:8px;text-align:right;">${count}건</td>
              <td style="padding:8px;min-width:80px;">
                <div style="height:6px;background:var(--border,#eee);border-radius:3px;overflow:hidden;">
                  <div style="height:100%;width:${barPct}%;background:var(--primary,#0066cc);border-radius:3px;"></div>
                </div>
              </td>
              <td style="padding:8px;text-align:right;color:${scoreColor};font-weight:600;">${avgScore}점</td>
              <td style="padding:8px;color:var(--text-muted);font-size:.8rem;">${lastDate}</td>
            </tr>`;
  }).join('')}
        </tbody>
      </table>
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
  renderIntegrityCheck(submissions);

  // Filters
  const researcherNames = Object.keys(researchers).sort();
  adminFilter.innerHTML = `
    <select id="filter-date">
      <option value="">전체 기간</option>
      <option value="today">오늘</option>
      <option value="7days">최근 7일</option>
      <option value="30days">최근 30일</option>
      <option value="custom">날짜 직접 선택</option>
    </select>
    <span id="filter-date-range" style="display:none;align-items:center;gap:4px;">
      <input type="date" id="filter-from" aria-label="시작일" style="font-size:.85rem;padding:4px 6px;" />
      <span>~</span>
      <input type="date" id="filter-to" aria-label="종료일" style="font-size:.85rem;padding:4px 6px;" />
    </span>
    <select id="filter-researcher">
      <option value="">전체 조사자</option>
      ${researcherNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}
    </select>
    <select id="filter-area">
      <option value="">전체 지역</option>
      ${areas.map((a) => `<option value="${a}">${a}</option>`).join('')}
    </select>
    <div style="position:relative;display:inline-block;">
      <input type="text" id="filter-store" placeholder="매장명 검색" style="padding-right:28px;" aria-label="매장명 검색" />
      <button type="button" id="filter-store-clear" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-muted,#999);font-size:16px;padding:2px 6px;display:none;line-height:1;" aria-label="검색 초기화">\u00D7</button>
    </div>
  `;
  const filterDate = adminFilter.querySelector('#filter-date');
  const filterDateRange = adminFilter.querySelector('#filter-date-range');
  const filterFrom = adminFilter.querySelector('#filter-from');
  const filterTo = adminFilter.querySelector('#filter-to');
  const filterResearcher = adminFilter.querySelector('#filter-researcher');
  const filterArea = adminFilter.querySelector('#filter-area');
  const filterStore = adminFilter.querySelector('#filter-store');
  const filterStoreClear = adminFilter.querySelector('#filter-store-clear');
  const doFilter = () => {
    const dateVal = filterDate.value === 'custom'
      ? { custom: true, from: filterFrom.value, to: filterTo.value }
      : filterDate.value;
    currentFilters = { date: dateVal, researcher: filterResearcher.value, area: filterArea.value, store: filterStore.value };
    submissionPage = 1;
    selectedSubmissionIds.clear();
    renderSubmissionList(currentFilters.date, currentFilters.researcher, currentFilters.area, currentFilters.store, 1);
  };
  filterDate.addEventListener('change', () => {
    filterDateRange.style.display = filterDate.value === 'custom' ? 'inline-flex' : 'none';
  });
  const doFilterDebounced = debounce(doFilter, 250);
  filterFrom.addEventListener('change', doFilter);
  filterTo.addEventListener('change', doFilter);
  filterResearcher.addEventListener('change', doFilter);
  filterArea.addEventListener('change', doFilter);
  filterStore.addEventListener('input', () => {
    filterStoreClear.style.display = filterStore.value ? 'block' : 'none';
    doFilterDebounced();
  });
  filterStoreClear.addEventListener('click', () => {
    filterStore.value = '';
    filterStoreClear.style.display = 'none';
    filterStore.focus();
    doFilter();
  });
  renderSubmissionList('', '', '', '');
  renderCharts();
  renderStoreProductChart();
  renderActivityHeatmap();
  renderRegionCompare();
  renderWeekCompare();
  bindResearcherDetails();
  renderPriceTrendDropdowns();
  renderProgressDashboard(submissions, areas);
}

// ── Survey progress dashboard ──
function renderProgressDashboard(submissions, areas) {
  let container = document.querySelector('#progress-dashboard');
  if (!container) {
    container = document.createElement('div');
    container.id = 'progress-dashboard';
    container.style.cssText = 'margin-top:16px;';
    const researcherStats = document.querySelector('#researcher-stats');
    if (researcherStats) researcherStats.insertAdjacentElement('beforebegin', container);
  }

  const todayStr = new Date().toDateString();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Per-area: count this week
  const areaCounts = {};
  submissions.forEach((s) => {
    const area = s.assignment?.currentArea;
    if (!area) return;
    if (!areaCounts[area]) areaCounts[area] = { total: 0, week: 0, today: 0 };
    areaCounts[area].total++;
    if (new Date(s.createdAt).getTime() >= weekAgo) areaCounts[area].week++;
    if (new Date(s.createdAt).toDateString() === todayStr) areaCounts[area].today++;
  });

  // Target: 5 submissions per area per week (configurable default)
  const TARGET_PER_AREA = 5;
  const sortedAreas = [...areas].sort((a, b) => (areaCounts[b]?.week || 0) - (areaCounts[a]?.week || 0));
  const totalWeek = submissions.filter((s) => new Date(s.createdAt).getTime() >= weekAgo).length;
  const totalTarget = areas.length * TARGET_PER_AREA;
  const overallPct = Math.min(100, Math.round((totalWeek / totalTarget) * 100));

  container.innerHTML = `
    <div class="card stack" style="padding:14px;">
      <h3 style="margin:0 0 10px;font-size:.95rem;">📈 조사 진행 현황 <span style="font-size:.75rem;font-weight:normal;color:var(--text-muted);">이번주 목표 ${totalTarget}건</span></h3>
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:4px;">
          <span>전체 진행률</span>
          <span><strong>${totalWeek}</strong>/${totalTarget}건 (${overallPct}%)</span>
        </div>
        <div style="height:8px;background:var(--border,#eee);border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${overallPct}%;background:${overallPct >= 80 ? 'var(--success,#27ae60)' : overallPct >= 50 ? '#f39c12' : 'var(--primary,#0066cc)'};border-radius:4px;transition:width .5s;"></div>
        </div>
      </div>
      <details>
        <summary style="cursor:pointer;font-size:.85rem;color:var(--text-muted);">지역별 상세 보기</summary>
        <div style="margin-top:8px;display:grid;gap:6px;">
          ${sortedAreas.map((area) => {
    const c = areaCounts[area] || { week: 0, today: 0 };
    const pct = Math.min(100, Math.round((c.week / TARGET_PER_AREA) * 100));
    const color = pct >= 100 ? 'var(--success,#27ae60)' : pct >= 60 ? '#f39c12' : 'var(--error,#e74c3c)';
    return `
            <div>
              <div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:2px;">
                <span>${escapeHtml(area)} ${c.today > 0 ? `<span style="color:var(--primary)">+${c.today}오늘</span>` : ''}</span>
                <span style="color:${color};">${c.week}/${TARGET_PER_AREA}</span>
              </div>
              <div style="height:5px;background:var(--border,#eee);border-radius:3px;overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;"></div>
              </div>
            </div>`;
  }).join('')}
        </div>
      </details>
    </div>
  `;
}

// ── Researcher detail profile ──
function bindResearcherDetails() {
  if (!adminData) return;
  const cards = document.querySelectorAll('.area-card[data-researcher]');
  cards.forEach((card, idx) => {
    card.addEventListener('click', () => {
      const detail = document.querySelector(`#rd-${idx}`);
      if (!detail) return;
      if (detail.classList.contains('open')) {
        detail.classList.remove('open');
        return;
      }
      // Close others
      document.querySelectorAll('.researcher-detail.open').forEach((d) => d.classList.remove('open'));
      const name = card.dataset.researcher;
      detail.innerHTML = buildResearcherDetail(name);
      detail.classList.add('open');
    });
  });
}

function buildResearcherDetail(name) {
  const { submissions } = adminData;
  const mine = submissions.filter((s) => s.researcher.name === name);
  const total = mine.length;
  if (total === 0) return '<p>데이터 없음</p>';

  const withPrice = mine.filter((s) => (s.prices || []).length > 0).length;
  const priceRate = Math.round((withPrice / total) * 100);
  const withPhoto = mine.filter((s) => s.photo).length;
  const photoRate = Math.round((withPhoto / total) * 100);

  // Top 3 areas
  const areaMap = {};
  mine.forEach((s) => {
    const a = s.assignment?.currentArea;
    if (a) areaMap[a] = (areaMap[a] || 0) + 1;
  });
  const topAreas = Object.entries(areaMap).sort((a, b) => b[1] - a[1]).slice(0, 3);

  // Store types
  const storeMap = {};
  mine.forEach((s) => {
    const t = s.survey.storeType;
    if (t) storeMap[t] = (storeMap[t] || 0) + 1;
  });
  const topStores = Object.entries(storeMap).sort((a, b) => b[1] - a[1]).slice(0, 3);

  // Recent 5
  const recent5 = [...mine].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);

  // Activity period
  const dates = mine.map((s) => new Date(s.createdAt).getTime());
  const firstDate = new Date(Math.min(...dates)).toLocaleDateString('ko-KR');
  const lastDate = new Date(Math.max(...dates)).toLocaleDateString('ko-KR');

  return `
    <div class="rd-grid">
      <div class="rd-item"><div class="rd-label">총 제출</div><div class="rd-value">${total}건</div></div>
      <div class="rd-item"><div class="rd-label">가격 입력률</div><div class="rd-value">${priceRate}%</div></div>
      <div class="rd-item"><div class="rd-label">사진 첨부율</div><div class="rd-value">${photoRate}%</div></div>
      <div class="rd-item"><div class="rd-label">활동 기간</div><div class="rd-value" style="font-size:12px;">${firstDate} ~ ${lastDate}</div></div>
    </div>
    <div class="rd-label" style="margin-bottom:4px;">주요 조사 지역</div>
    <div class="rd-tags">${topAreas.map(([a, c]) => `<span class="rd-tag">${escapeHtml(a)} (${c})</span>`).join('')}</div>
    <div class="rd-label" style="margin-top:8px;margin-bottom:4px;">주요 매장유형</div>
    <div class="rd-tags">${topStores.map(([t, c]) => `<span class="rd-tag">${escapeHtml(t)} (${c})</span>`).join('')}</div>
    <div class="rd-recent">
      <div class="rd-label" style="margin-bottom:4px;">최근 5건</div>
      ${recent5.map((s) => `
        <div class="rd-recent-item">
          <span>${escapeHtml(s.survey.storeName)}</span>
          <span style="color:var(--text-muted);font-size:12px;">${new Date(s.createdAt).toLocaleDateString('ko-KR')}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ── Price trend ──
function renderPriceTrendDropdowns() {
  if (!adminData) return;
  const products = adminData.products || [];
  const prodSelect = document.querySelector('#trend-product');
  const sizeSelect = document.querySelector('#trend-size');

  prodSelect.innerHTML = '<option value="">제품 선택</option>' +
    products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('');

  prodSelect.addEventListener('change', () => {
    const pid = prodSelect.value;
    const prod = products.find((p) => p.id === pid);
    if (!prod) {
      sizeSelect.innerHTML = '<option value="">사이즈 선택</option>';
      document.querySelector('#trend-chart').innerHTML = '';
      return;
    }
    sizeSelect.innerHTML = '<option value="">사이즈 선택</option>' +
      prod.sizes.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    document.querySelector('#trend-chart').innerHTML = '';
  });

  sizeSelect.addEventListener('change', () => {
    renderPriceTrend(prodSelect.value, sizeSelect.value);
  });
}

function renderPriceTrend(productId, size) {
  const chart = document.querySelector('#trend-chart');
  if (!productId || !size || !adminData) {
    chart.innerHTML = '';
    return;
  }

  const products = adminData.products || [];
  const prod = products.find((p) => p.id === productId);
  if (!prod) { chart.innerHTML = ''; return; }

  // Gather matching price entries with timestamps
  const entries = [];
  adminData.submissions.forEach((s) => {
    (s.prices || []).forEach((p) => {
      if (p.productLabel === prod.label && p.size === size && p.price) {
        entries.push({
          date: new Date(s.createdAt),
          price: Number(String(p.price).replace(/[^0-9]/g, '')),
          store: s.survey.storeName,
          area: s.assignment?.currentArea || ''
        });
      }
    });
  });

  if (entries.length === 0) {
    chart.innerHTML = '<div class="notice">해당 제품/사이즈의 가격 데이터가 없어요.</div>';
    return;
  }

  // Sort by date
  entries.sort((a, b) => a.date - b.date);

  const prices = entries.map((e) => e.price);
  const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const barMax = maxP * 1.1 || 1;

  chart.innerHTML = `
    <div style="max-height:300px;overflow-y:auto;">
      ${entries.map((e) => {
        const pct = Math.round((e.price / barMax) * 100);
        const isOutlier = Math.abs(e.price - avg) > avg * 0.3;
        const dateStr = e.date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
        return `
        <div class="trend-bar-row">
          <span class="trend-bar-label" title="${escapeHtml(e.store)}">${dateStr} ${escapeHtml(e.store)}</span>
          <div class="trend-bar-track">
            <div class="trend-bar-fill ${isOutlier ? 'outlier' : ''}" style="width:${pct}%;background:${isOutlier ? 'var(--error)' : 'var(--primary)'};"></div>
          </div>
          <span class="trend-bar-value" style="${isOutlier ? 'color:var(--error);' : ''}">\u20A9${e.price.toLocaleString()}</span>
        </div>`;
      }).join('')}
    </div>
    <div class="trend-stats">
      <div class="trend-stat"><div class="ts-label">최저가</div><div class="ts-value">\u20A9${minP.toLocaleString()}</div></div>
      <div class="trend-stat"><div class="ts-label">최고가</div><div class="ts-value">\u20A9${maxP.toLocaleString()}</div></div>
      <div class="trend-stat"><div class="ts-label">평균가</div><div class="ts-value">\u20A9${Math.round(avg).toLocaleString()}</div></div>
    </div>
  `;
}

// ── Store-type x Product grouped bar chart ──
function renderStoreProductChart() {
  if (!adminData) return;
  const container = document.querySelector('#chart-store-product');
  const { submissions } = adminData;
  const products = getActiveProducts();
  if (!submissions.length || !products.length) {
    container.innerHTML = '<h2>🏪 매장유형별 제품 보유율</h2><div class="notice">데이터가 없어요.</div>';
    return;
  }

  // Count submissions per store type, and per store type+product
  const storeTypes = {};
  submissions.forEach((s) => {
    const st = s.survey.storeType;
    if (!st) return;
    if (!storeTypes[st]) storeTypes[st] = { total: 0, products: {} };
    storeTypes[st].total++;
    const priceProducts = new Set((s.prices || []).map((p) => p.productLabel));
    products.forEach((prod) => {
      if (priceProducts.has(prod.label)) {
        storeTypes[st].products[prod.label] = (storeTypes[st].products[prod.label] || 0) + 1;
      }
    });
  });

  const stEntries = Object.entries(storeTypes).sort((a, b) => b[1].total - a[1].total);
  const colors = ['#0066cc', '#ff6b35', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f'];

  // Build insights
  const insights = [];
  stEntries.forEach(([st, data]) => {
    products.forEach((prod) => {
      const rate = data.total ? Math.round(((data.products[prod.label] || 0) / data.total) * 100) : 0;
      if (rate >= 70) insights.push(`${st}에서 ${prod.label} 보유율: ${rate}%`);
    });
  });

  container.innerHTML = `
    <h2>🏪 매장유형별 제품 보유율</h2>
    <div class="group-bar-section">
      ${stEntries.map(([st, data]) => {
        return `
        <div class="group-bar-row">
          <span class="group-bar-label">${escapeHtml(st)}</span>
          <div class="group-bar-bars">
            ${products.map((prod, pi) => {
              const rate = data.total ? Math.round(((data.products[prod.label] || 0) / data.total) * 100) : 0;
              return `<div class="group-bar-seg" style="width:${Math.max(rate, 2)}%;background:${colors[pi % colors.length]};" data-tip="${escapeHtml(prod.label)}: ${rate}%"></div>`;
            }).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="group-bar-legend">
      ${products.map((prod, pi) => `
        <span class="group-bar-legend-item"><span class="group-bar-legend-dot" style="background:${colors[pi % colors.length]};"></span>${escapeHtml(prod.label)}</span>
      `).join('')}
    </div>
    ${insights.length ? `<div class="group-bar-insight">💡 ${insights.map((i) => escapeHtml(i)).join(' · ')}</div>` : ''}
  `;
}

// ── Activity heatmap (day x hour) ──
function renderActivityHeatmap() {
  if (!adminData) return;
  const container = document.querySelector('#chart-activity-heatmap');
  const { submissions } = adminData;
  if (!submissions.length) {
    container.innerHTML = '<h2>⏰ 활동 시간대</h2><div class="notice">데이터가 없어요.</div>';
    return;
  }

  const dayNames = ['월', '화', '수', '목', '금', '토', '일'];
  // grid[day][hour] — day 0=Mon
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let maxVal = 0;

  submissions.forEach((s) => {
    const d = new Date(s.createdAt);
    const jsDay = d.getDay(); // 0=Sun
    const day = jsDay === 0 ? 6 : jsDay - 1; // 0=Mon ... 6=Sun
    const hour = d.getHours();
    grid[day][hour]++;
    if (grid[day][hour] > maxVal) maxVal = grid[day][hour];
  });

  const cellColor = (val) => {
    if (val === 0) return 'var(--border)';
    const intensity = Math.round((val / maxVal) * 200 + 55);
    return `rgb(${255 - intensity}, ${Math.min(200, 100 + intensity)}, ${255 - intensity * 1.2 < 0 ? 0 : Math.round(255 - intensity * 1.2)})`;
  };

  // Header row
  let headerHtml = '<div class="heatmap-day-label"></div>';
  for (let h = 0; h < 24; h++) {
    headerHtml += `<div class="heatmap-header">${h}</div>`;
  }

  let gridHtml = headerHtml;
  for (let d = 0; d < 7; d++) {
    gridHtml += `<div class="heatmap-day-label">${dayNames[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const val = grid[d][h];
      gridHtml += `<div class="heatmap-cell" style="background:${cellColor(val)};" title="${dayNames[d]} ${h}시: ${val}건">${val || ''}</div>`;
    }
  }

  container.innerHTML = `
    <h2>⏰ 활동 시간대</h2>
    <div class="heatmap-grid">${gridHtml}</div>
  `;
}

// ── Region comparison table ──
let regionSortCol = 0;
let regionSortAsc = false;

function renderRegionCompare() {
  if (!adminData) return;
  const container = document.querySelector('#chart-region-compare');
  const { submissions } = adminData;
  const areas = getActiveAreas();
  if (!submissions.length || !areas.length) {
    container.innerHTML = '<h2>📊 지역별 상세 비교</h2><div class="notice">데이터가 없어요.</div>';
    return;
  }

  // Build per-area stats
  const areaStats = areas.map((area) => {
    const mine = submissions.filter((s) => s.assignment?.currentArea === area);
    const total = mine.length;
    const researchers = new Set(mine.map((s) => s.researcher.name)).size;

    // Average ionkick price
    const ionkickPrices = [];
    mine.forEach((s) => {
      (s.prices || []).forEach((p) => {
        if (p.productLabel && p.productLabel.includes('이온킥') && p.price) {
          const num = Number(String(p.price).replace(/[^0-9]/g, ''));
          if (num > 0) ionkickPrices.push(num);
        }
      });
    });
    const avgPrice = ionkickPrices.length ? Math.round(ionkickPrices.reduce((a, b) => a + b, 0) / ionkickPrices.length) : 0;

    // Photo rate
    const withPhoto = mine.filter((s) => s.photo).length;
    const photoRate = total ? Math.round((withPhoto / total) * 100) : 0;

    return { area, total, researchers, avgPrice, photoRate };
  }).filter((a) => a.total > 0);

  // Sort
  const cols = ['area', 'total', 'researchers', 'avgPrice', 'photoRate'];
  const sortKey = cols[regionSortCol] || 'total';
  areaStats.sort((a, b) => {
    const va = a[sortKey];
    const vb = b[sortKey];
    if (typeof va === 'string') return regionSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return regionSortAsc ? va - vb : vb - va;
  });

  const arrows = cols.map((_, i) => i === regionSortCol ? (regionSortAsc ? '▲' : '▼') : '');

  container.innerHTML = `
    <h2>📊 지역별 상세 비교</h2>
    <div style="overflow-x:auto;">
      <table class="region-table">
        <thead><tr>
          <th data-col="0">지역 <span class="sort-arrow">${arrows[0]}</span></th>
          <th data-col="1">총 제출 <span class="sort-arrow">${arrows[1]}</span></th>
          <th data-col="2">조사자 수 <span class="sort-arrow">${arrows[2]}</span></th>
          <th data-col="3">평균 가격(이온킥) <span class="sort-arrow">${arrows[3]}</span></th>
          <th data-col="4">사진 첨부율 <span class="sort-arrow">${arrows[4]}</span></th>
        </tr></thead>
        <tbody>
          ${areaStats.map((a) => `
            <tr>
              <td style="font-weight:600;">${escapeHtml(a.area)}</td>
              <td>${a.total}건</td>
              <td>${a.researchers}명</td>
              <td>${a.avgPrice ? '₩' + a.avgPrice.toLocaleString() : '-'}</td>
              <td>${a.photoRate}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Bind sort
  container.querySelectorAll('th[data-col]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = Number(th.dataset.col);
      if (regionSortCol === col) {
        regionSortAsc = !regionSortAsc;
      } else {
        regionSortCol = col;
        regionSortAsc = col === 0; // area ascending by default, others descending
      }
      renderRegionCompare();
    });
  });
}

// ── Data integrity check ──
function renderIntegrityCheck(submissions) {
  let container = document.querySelector('#integrity-check');
  if (!container) {
    container = document.createElement('div');
    container.id = 'integrity-check';
    container.style.cssText = 'margin-top:16px;';
    const researcherStats = document.querySelector('#researcher-stats');
    if (researcherStats) researcherStats.appendChild(container);
  }

  // Find duplicates: same researcher + same storeName + same day
  const seen = {};
  const duplicates = [];
  submissions.forEach((s) => {
    const dayKey = `${s.researcher.name}|${s.survey.storeName}|${new Date(s.createdAt).toDateString()}`;
    if (seen[dayKey]) {
      duplicates.push(s);
    } else {
      seen[dayKey] = true;
    }
  });

  // Find price outliers: per product+size, flag price > mean + 2*stdev
  const priceGroups = {};
  submissions.forEach((s) => {
    (s.prices || []).forEach((p) => {
      const key = `${p.productLabel}|${p.size}`;
      const num = Number(String(p.price).replace(/[^0-9]/g, ''));
      if (num > 0) {
        if (!priceGroups[key]) priceGroups[key] = [];
        priceGroups[key].push({ num, storeName: s.survey.storeName, date: s.createdAt });
      }
    });
  });
  const outliers = [];
  Object.entries(priceGroups).forEach(([key, vals]) => {
    if (vals.length < 3) return;
    const mean = vals.reduce((a, b) => a + b.num, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + Math.pow(b.num - mean, 2), 0) / vals.length;
    const stdev = Math.sqrt(variance);
    if (stdev < 1) return;
    vals.forEach((v) => {
      if (Math.abs(v.num - mean) > 2 * stdev) {
        outliers.push({ key, price: v.num, storeName: v.storeName, mean: Math.round(mean) });
      }
    });
  });

  const issues = duplicates.length + outliers.length;
  if (issues === 0) {
    container.innerHTML = `<div style="padding:10px;background:var(--bg-alt,#f5f5f5);border-radius:8px;font-size:.85rem;color:var(--success,#27ae60);">✅ 데이터 무결성 이상 없음</div>`;
    return;
  }

  const dupHtml = duplicates.length > 0 ? `
    <div style="margin-bottom:8px;">
      <strong>⚠️ 중복 의심 ${duplicates.length}건</strong>
      <div style="font-size:.82rem;color:var(--text-muted);margin-top:4px;">
        ${duplicates.slice(0, 5).map((s) => `${escapeHtml(s.researcher.name)} · ${escapeHtml(s.survey.storeName)} (${new Date(s.createdAt).toLocaleDateString('ko-KR')})`).join('<br>')}
        ${duplicates.length > 5 ? `<span> 외 ${duplicates.length - 5}건</span>` : ''}
      </div>
    </div>` : '';

  const outlierHtml = outliers.length > 0 ? `
    <div>
      <strong>📊 가격 이상값 ${outliers.length}건</strong>
      <div style="font-size:.82rem;color:var(--text-muted);margin-top:4px;">
        ${outliers.slice(0, 5).map((o) => `${escapeHtml(o.key)}: ₩${o.price.toLocaleString()} (평균 ₩${o.mean.toLocaleString()}) — ${escapeHtml(o.storeName)}`).join('<br>')}
        ${outliers.length > 5 ? `<span> 외 ${outliers.length - 5}건</span>` : ''}
      </div>
    </div>` : '';

  container.innerHTML = `
    <details style="background:var(--bg-alt,#f5f5f5);border-radius:8px;padding:10px;">
      <summary style="cursor:pointer;font-size:.88rem;font-weight:600;color:#e67e22;">⚠️ 데이터 이상 ${issues}건 감지됨</summary>
      <div style="margin-top:8px;font-size:.85rem;">${dupHtml}${outlierHtml}</div>
    </details>`;
}

function applyDateFilter(submissions, dateFilter) {
  if (!dateFilter) return submissions;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Custom date range object
  if (typeof dateFilter === 'object' && dateFilter.custom) {
    const { from, to } = dateFilter;
    return submissions.filter((s) => {
      const d = new Date(s.createdAt);
      if (from && d < new Date(from)) return false;
      if (to) {
        const toEnd = new Date(to);
        toEnd.setHours(23, 59, 59, 999);
        if (d > toEnd) return false;
      }
      return true;
    });
  }
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

function renderSubmissionList(dateFilter, researcherFilter, areaFilter, storeFilter, page) {
  if (!adminData) return;
  page = page || submissionPage || 1;
  submissionPage = page;

  const { submissions, areas, products } = adminData;
  let filtered = submissions;

  filtered = applyDateFilter(filtered, dateFilter);
  if (researcherFilter) filtered = filtered.filter((s) => s.researcher.name === researcherFilter);
  if (areaFilter) filtered = filtered.filter((s) => s.assignment?.currentArea === areaFilter);
  if (storeFilter) {
    const q = storeFilter.toLowerCase();
    filtered = filtered.filter((s) => s.survey.storeName.toLowerCase().includes(q));
  }

  const totalCount = filtered.length;
  lastFilteredCount = totalCount;
  const totalPages = Math.max(1, Math.ceil(totalCount / SUBMISSION_PAGE_SIZE));
  if (page > totalPages) { submissionPage = totalPages; page = totalPages; }
  const paginated = filtered.slice((page - 1) * SUBMISSION_PAGE_SIZE, page * SUBMISSION_PAGE_SIZE);

  // Quick stats row
  const todayStr = new Date().toDateString();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const todayFiltered = filtered.filter((s) => new Date(s.createdAt).toDateString() === todayStr).length;
  const weekFiltered = filtered.filter((s) => new Date(s.createdAt).getTime() >= weekAgo).length;
  const avgScore = filtered.length > 0
    ? Math.round(filtered.reduce((sum, s) => sum + (s.completenessScore ?? 0), 0) / filtered.length)
    : 0;
  const quickStatsRow = `
    <div style="display:flex;gap:12px;padding:8px 0;font-size:.82rem;color:var(--text-muted);flex-wrap:wrap;border-bottom:1px solid var(--border,#eee);margin-bottom:8px;" role="status" aria-label="필터 결과 통계">
      <span>전체 <strong>${totalCount}</strong>건</span>
      <span>오늘 <strong>${todayFiltered}</strong>건</span>
      <span>7일 <strong>${weekFiltered}</strong>건</span>
      <span>평균완료도 <strong>${avgScore}점</strong></span>
    </div>
  `;

  // Bulk action toolbar
  const bulkSelected = selectedSubmissionIds.size;
  const bulkBar = bulkSelectMode ? `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-alt,#f5f5f5);border-radius:8px;margin-bottom:8px;flex-wrap:wrap;">
      <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer;">
        <input type="checkbox" id="bulk-select-all" ${bulkSelected === paginated.length && paginated.length > 0 ? 'checked' : ''} />
        전체 선택
      </label>
      <span style="font-size:.85rem;color:var(--text-muted);">${bulkSelected}건 선택됨</span>
      <button type="button" class="btn btn-secondary" id="bulk-delete-btn" ${bulkSelected === 0 ? 'disabled' : ''} style="font-size:.8rem;padding:4px 10px;">🗑️ 선택 삭제</button>
      <button type="button" class="btn btn-secondary" id="bulk-export-btn" ${bulkSelected === 0 ? 'disabled' : ''} style="font-size:.8rem;padding:4px 10px;">📥 선택 내보내기</button>
      <button type="button" class="btn btn-secondary" id="bulk-cancel-btn" style="font-size:.8rem;padding:4px 10px;">취소</button>
    </div>
  ` : `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <span style="font-size:.85rem;color:var(--text-muted);">총 ${totalCount}건</span>
      <button type="button" class="btn btn-secondary" id="bulk-toggle-btn" style="font-size:.8rem;padding:4px 10px;">☑️ 선택 모드</button>
    </div>
  `;

  const cardsHtml = paginated.length
    ? paginated.map((sub) => {
        const isSelected = selectedSubmissionIds.has(sub.id);
        const priceRows = (sub.prices || []).map((p) =>
          `<tr><td>${escapeHtml(p.productLabel)}</td><td>${escapeHtml(p.size)}</td><td style="text-align:right;">\u20A9${Number(p.price).toLocaleString()}</td></tr>`
        ).join('');
        const gps = sub.gps || sub.location;
        const gpsText = gps ? `${gps.lat?.toFixed(5)}, ${gps.lng?.toFixed(5)}` : '-';
        const checkboxHtml = bulkSelectMode
          ? `<input type="checkbox" class="bulk-checkbox" data-id="${sub.id}" ${isSelected ? 'checked' : ''} style="margin-right:8px;width:16px;height:16px;cursor:pointer;" aria-label="${escapeHtml(sub.survey.storeName)} 선택" />`
          : '';

        return `
      <article class="submission-card" data-id="${sub.id}" ${isSelected ? 'style="outline:2px solid var(--primary);"' : ''}>
        <div class="sub-header" style="cursor:pointer;display:flex;align-items:center;" data-toggle="${sub.id}">
          ${checkboxHtml}
          <span class="store-name">${highlightMatch(sub.survey.storeName, storeFilter)}</span>
          <span class="sub-date" style="margin-left:auto;">${new Date(sub.createdAt).toLocaleDateString('ko-KR')}</span>
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
          ${sub.photo ? `<img class="sub-photo" src="${sub.photo.url}" alt="${escapeHtml(sub.survey.storeName)}" loading="lazy" />` : ''}
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

  // Pagination controls
  const paginationHtml = totalPages > 1 ? `
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;flex-wrap:wrap;">
      <button type="button" class="btn btn-secondary" id="pg-first" ${page === 1 ? 'disabled' : ''} style="font-size:.8rem;padding:4px 10px;">«</button>
      <button type="button" class="btn btn-secondary" id="pg-prev" ${page === 1 ? 'disabled' : ''} style="font-size:.8rem;padding:4px 10px;">‹ 이전</button>
      <span style="font-size:.85rem;color:var(--text-muted);">${page} / ${totalPages}페이지</span>
      <button type="button" class="btn btn-secondary" id="pg-next" ${page >= totalPages ? 'disabled' : ''} style="font-size:.8rem;padding:4px 10px;">다음 ›</button>
      <button type="button" class="btn btn-secondary" id="pg-last" ${page >= totalPages ? 'disabled' : ''} style="font-size:.8rem;padding:4px 10px;">»</button>
    </div>
  ` : '';

  submissionList.innerHTML = quickStatsRow + bulkBar + cardsHtml + paginationHtml;

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
        showToast('지역이 변경되었어요. ✓', 'success');
        await loadAdminData();
      }
    });
  });

  submissionList.querySelectorAll('[data-action="delete"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const confirmed = await new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'price-reminder-overlay';
        overlay.innerHTML = `
          <div class="price-reminder-dialog" role="alertdialog" aria-modal="true" aria-labelledby="del-dialog-title">
            <p id="del-dialog-title">이 기록을 삭제할까요?<br/><span style="font-size:.85rem;color:var(--text-muted,#666);">되돌릴 수 없어요.</span></p>
            <div class="price-reminder-actions">
              <button type="button" class="btn btn-secondary" id="del-cancel-btn">취소</button>
              <button type="button" class="btn btn-primary" style="background:var(--error,#e74c3c);border-color:var(--error,#e74c3c);" id="del-confirm-btn">삭제</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);
        const keyHandler = (e) => {
          if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', keyHandler); resolve(false); }
        };
        document.addEventListener('keydown', keyHandler);
        overlay.querySelector('#del-cancel-btn').addEventListener('click', () => { overlay.remove(); document.removeEventListener('keydown', keyHandler); resolve(false); });
        overlay.querySelector('#del-confirm-btn').addEventListener('click', () => { overlay.remove(); document.removeEventListener('keydown', keyHandler); resolve(true); });
        overlay.querySelector('#del-confirm-btn').focus();
      });
      if (!confirmed) return;
      const response = await authFetch('/api/submissions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId: button.dataset.submissionId })
      });
      if (response.ok) {
        showToast('삭제되었어요. ✓', 'success');
        await loadAdminData();
      } else {
        showToast('삭제에 실패했어요.', 'error');
      }
    });
  });

  // ── Pagination events ──
  const pgFirst = submissionList.querySelector('#pg-first');
  const pgPrev = submissionList.querySelector('#pg-prev');
  const pgNext = submissionList.querySelector('#pg-next');
  const pgLast = submissionList.querySelector('#pg-last');

  if (pgFirst) pgFirst.addEventListener('click', () => renderSubmissionList(currentFilters.date, currentFilters.researcher, currentFilters.area, currentFilters.store, 1));
  if (pgPrev) pgPrev.addEventListener('click', () => renderSubmissionList(currentFilters.date, currentFilters.researcher, currentFilters.area, currentFilters.store, submissionPage - 1));
  if (pgNext) pgNext.addEventListener('click', () => renderSubmissionList(currentFilters.date, currentFilters.researcher, currentFilters.area, currentFilters.store, submissionPage + 1));
  if (pgLast) pgLast.addEventListener('click', () => {
    const last = Math.max(1, Math.ceil(lastFilteredCount / SUBMISSION_PAGE_SIZE));
    renderSubmissionList(currentFilters.date, currentFilters.researcher, currentFilters.area, currentFilters.store, last);
  });

  // ── Bulk action events ──
  const bulkToggleBtn = submissionList.querySelector('#bulk-toggle-btn');
  if (bulkToggleBtn) {
    bulkToggleBtn.addEventListener('click', () => {
      bulkSelectMode = true;
      selectedSubmissionIds.clear();
      renderSubmissionList(currentFilters.date, currentFilters.researcher, currentFilters.area, currentFilters.store, submissionPage);
    });
  }

  const bulkCancelBtn = submissionList.querySelector('#bulk-cancel-btn');
  if (bulkCancelBtn) {
    bulkCancelBtn.addEventListener('click', () => {
      bulkSelectMode = false;
      selectedSubmissionIds.clear();
      renderSubmissionList(currentFilters.date, currentFilters.researcher, currentFilters.area, currentFilters.store, submissionPage);
    });
  }

  const bulkSelectAll = submissionList.querySelector('#bulk-select-all');
  if (bulkSelectAll) {
    bulkSelectAll.addEventListener('change', () => {
      submissionList.querySelectorAll('.bulk-checkbox').forEach((cb) => {
        if (bulkSelectAll.checked) selectedSubmissionIds.add(cb.dataset.id);
        else selectedSubmissionIds.delete(cb.dataset.id);
        cb.checked = bulkSelectAll.checked;
      });
      renderSubmissionList(currentFilters.date, currentFilters.researcher, currentFilters.area, currentFilters.store, submissionPage);
    });
  }

  submissionList.querySelectorAll('.bulk-checkbox').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      if (cb.checked) selectedSubmissionIds.add(cb.dataset.id);
      else selectedSubmissionIds.delete(cb.dataset.id);
      renderSubmissionList(currentFilters.date, currentFilters.researcher, currentFilters.area, currentFilters.store, submissionPage);
    });
    cb.addEventListener('click', (e) => e.stopPropagation());
  });

  const bulkDeleteBtn = submissionList.querySelector('#bulk-delete-btn');
  if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener('click', async () => {
      if (selectedSubmissionIds.size === 0) return;
      const confirmed = await new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'price-reminder-overlay';
        overlay.innerHTML = `
          <div class="price-reminder-dialog" role="alertdialog" aria-modal="true">
            <p>${selectedSubmissionIds.size}건을 일괄 삭제할까요?<br/><span style="font-size:.85rem;color:var(--text-muted);">되돌릴 수 없어요.</span></p>
            <div class="price-reminder-actions">
              <button type="button" class="btn btn-secondary" id="bdel-cancel">취소</button>
              <button type="button" class="btn btn-primary" style="background:var(--error,#e74c3c);border-color:var(--error,#e74c3c);" id="bdel-confirm">삭제</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);
        const kh = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', kh); resolve(false); } };
        document.addEventListener('keydown', kh);
        overlay.querySelector('#bdel-cancel').addEventListener('click', () => { overlay.remove(); document.removeEventListener('keydown', kh); resolve(false); });
        overlay.querySelector('#bdel-confirm').addEventListener('click', () => { overlay.remove(); document.removeEventListener('keydown', kh); resolve(true); });
        overlay.querySelector('#bdel-confirm').focus();
      });
      if (!confirmed) return;
      let successCount = 0;
      for (const id of selectedSubmissionIds) {
        const res = await authFetch('/api/submissions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ submissionId: id }) });
        if (res.ok) successCount++;
      }
      showToast(`${successCount}건 삭제되었어요. ✓`, 'success');
      bulkSelectMode = false;
      selectedSubmissionIds.clear();
      await loadAdminData();
    });
  }

  const bulkExportBtn = submissionList.querySelector('#bulk-export-btn');
  if (bulkExportBtn) {
    bulkExportBtn.addEventListener('click', () => {
      if (selectedSubmissionIds.size === 0) return;
      const { submissions, products } = adminData;
      const selected = submissions.filter((s) => selectedSubmissionIds.has(s.id));
      const priceHeaders = [];
      for (const product of (products || [])) {
        for (const size of product.sizes) priceHeaders.push(`${product.label} ${size}`);
      }
      const headers = ['제출일시', '조사자', '조사지역', '매장유형', '매장명', 'POS대수', ...priceHeaders, '메모'];
      const rows = selected.map((sub) => {
        const priceMap = {};
        (sub.prices || []).forEach((p) => { priceMap[`${p.productLabel} ${p.size}`] = p.price; });
        const priceCols = priceHeaders.map((h) => String(priceMap[h] || '').replace(/[^0-9]/g, ''));
        return [formatDateCSV(sub.createdAt), sub.researcher.name, sub.assignment?.currentArea || '', sub.survey.storeType, sub.survey.storeName, sub.survey.posCount, ...priceCols, sub.notes || ''];
      });
      const csvContent = [headers, ...rows].map((row) => row.map((cell) => {
        const str = String(cell);
        return (str.includes(',') || str.includes('"') || str.includes('\n')) ? '"' + str.replace(/"/g, '""') + '"' : str;
      }).join(',')).join('\r\n');
      const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ionroad-selected-${selected.length}건-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`${selected.length}건 내보내기 완료. ✓`, 'success');
    });
  }
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

  const headers = ['제출일시', '조사자', '거주지역', '조사지역', '매장유형', '매장명', 'POS대수', '진열위치', ...priceHeaders, '완료도', '메모', '위도', '경도'];

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
      sub.completenessScore ?? '',
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
  showToast('CSV 파일이 다운로드되었어요. ✓', 'success');
});

// ── JSON Export ──
(function addJsonExportBtn() {
  const csvBtn = document.querySelector('#csv-btn');
  if (!csvBtn) return;
  const jsonBtn = document.createElement('button');
  jsonBtn.type = 'button';
  jsonBtn.id = 'json-btn';
  jsonBtn.textContent = '📥 JSON';
  jsonBtn.className = csvBtn.className;
  jsonBtn.style.cssText = 'margin-left:8px;';
  jsonBtn.setAttribute('aria-label', 'JSON 내보내기');
  csvBtn.parentNode.insertBefore(jsonBtn, csvBtn.nextSibling);
  jsonBtn.addEventListener('click', () => {
    if (!adminData) return;
    const { submissions } = adminData;
    const exportData = submissions.map((sub) => ({
      id: sub.id,
      createdAt: sub.createdAt,
      researcher: sub.researcher,
      assignment: sub.assignment,
      survey: sub.survey,
      prices: sub.prices || [],
      notes: sub.notes || '',
      completenessScore: sub.completenessScore,
      gps: sub.gps || sub.location || null
    }));
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ionroad-export-${submissions.length}건-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('JSON 파일이 다운로드되었어요. ✓', 'success');
  });
})();

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
    showToast('백업 파일이 다운로드되었어요. ✓', 'success');
  } catch {
    showToast('백업에 실패했어요.', 'error');
  }
});

// ── Helpers ──
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightMatch(text, query) {
  const escaped = escapeHtml(String(text || ''));
  if (!query) return escaped;
  const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp('(' + safeQuery + ')', 'gi'), '<mark style="background:#fff3cd;padding:0 2px;border-radius:2px;">$1</mark>');
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
  showToast('설정이 저장되었어요. ✓', 'success');
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

// ── Summary print ──
document.querySelector('#summary-btn').addEventListener('click', () => {
  const title = document.querySelector('#admin-title');
  title.setAttribute('data-print-date', new Date().toLocaleDateString('ko-KR'));
  window.print();
});

// ── Data import ──
document.querySelector('#import-btn').addEventListener('click', () => {
  document.querySelector('#import-file').click();
});

document.querySelector('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const submissions = data.submissions || data;
    if (!Array.isArray(submissions)) {
      showToast('올바른 JSON 형식이 아니에요.', 'error');
      return;
    }
    const res = await authFetch('/api/admin/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissions })
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || '가져오기에 실패했어요.', 'error');
      return;
    }
    const result = await res.json();
    showToast(`${result.imported}건 가져옴, ${result.skipped}건 중복 스킵 ✓`, 'success');
    if (result.imported > 0) await loadAdminData();
  } catch {
    showToast('파일을 읽을 수 없어요.', 'error');
  }
  e.target.value = '';
});

// ── Password change ──
document.querySelector('#change-password-btn').addEventListener('click', async () => {
  const currentPw = document.querySelector('#current-password').value.trim();
  const newPw = document.querySelector('#new-password').value.trim();
  if (!currentPw || !newPw) {
    showToast('비밀번호를 모두 입력해주세요.', 'error');
    return;
  }
  if (newPw.length < 4) {
    showToast('새 비밀번호는 4자 이상이어야 합니다.', 'error');
    return;
  }
  try {
    const res = await authFetch('/api/admin/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || '변경에 실패했어요.', 'error');
      return;
    }
    showToast('비밀번호가 변경되었어요. ✓', 'success');
    document.querySelector('#current-password').value = '';
    document.querySelector('#new-password').value = '';
  } catch {
    showToast('서버에 연결할 수 없어요.', 'error');
  }
});

// ── Dark mode (admin) ──
function initAdminDarkMode() {
  const saved = localStorage.getItem('kwangdong_theme');
  if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark');

  const btn = document.createElement('button');
  btn.id = 'admin-dark-mode-toggle';
  btn.setAttribute('aria-label', '다크 모드 전환');
  btn.setAttribute('aria-pressed', saved === 'dark' ? 'true' : 'false');
  btn.style.cssText = 'position:fixed;bottom:24px;right:16px;z-index:900;width:40px;height:40px;border-radius:50%;border:1px solid var(--border,#ddd);background:var(--bg-card,#fff);color:var(--text,#222);font-size:1.1rem;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.15);display:flex;align-items:center;justify-content:center;';
  btn.textContent = saved === 'dark' ? '☀️' : '🌙';
  document.body.appendChild(btn);

  btn.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('kwangdong_theme', 'light');
      btn.textContent = '🌙';
      btn.setAttribute('aria-pressed', 'false');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('kwangdong_theme', 'dark');
      btn.textContent = '☀️';
      btn.setAttribute('aria-pressed', 'true');
    }
  });
}

// ── Init ──
initAdminDarkMode();
init();
