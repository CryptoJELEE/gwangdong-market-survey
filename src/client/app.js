const state = {
  bootstrap: null,
  mapInitialized: false,
  kakaoMap: null,
  gps: { lat: null, lng: null, status: 'pending' },
  currentStep: 1,
  photoDataUrl: '',
  selectedStoreType: ''
};

// ── DOM refs ──
const surveyForm = document.querySelector('#survey-form');
const formStepContainer = document.querySelector('#form-step-container');
const stepIndicator = document.querySelector('#step-indicator');
const successView = document.querySelector('#success-view');
const submissionList = document.querySelector('#submission-list');
const adminStats = document.querySelector('#admin-stats');
const adminFilter = document.querySelector('#admin-filter');
const gpsStatusEl = document.querySelector('#gps-status');
const statusResearcher = document.querySelector('#status-researcher');
const navTabs = [...document.querySelectorAll('.nav-tab')];
const panels = [...document.querySelectorAll('.panel')];

// ── Navigation ──
navTabs.forEach((button) => {
  button.addEventListener('click', () => {
    navTabs.forEach((t) => t.classList.toggle('is-active', t === button));
    panels.forEach((p) => p.classList.toggle('is-active', p.id === button.dataset.tab));
    if (button.dataset.tab === 'map') initMap();
  });
});

// ── GPS ──
function initGps() {
  if (!navigator.geolocation) {
    state.gps.status = 'unavailable';
    updateGpsStatus();
    return;
  }
  state.gps.status = 'pending';
  updateGpsStatus();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.gps.lat = pos.coords.latitude;
      state.gps.lng = pos.coords.longitude;
      state.gps.status = 'ready';
      updateGpsStatus();
    },
    () => {
      state.gps.status = 'unavailable';
      updateGpsStatus();
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function updateGpsStatus() {
  const labels = {
    pending: '\u{1F4CD} 위치 확인 중...',
    ready: '\u{1F4CD} 위치 확인됨',
    unavailable: '\u26A0\uFE0F 위치 사용 불가'
  };
  gpsStatusEl.textContent = labels[state.gps.status] || '';
}

// ── localStorage helpers ──
function saveLocal(key, value) {
  try { localStorage.setItem('kwangdong_' + key, value); } catch {}
}
function loadLocal(key) {
  try { return localStorage.getItem('kwangdong_' + key) || ''; } catch { return ''; }
}

// ── Price field naming ──
function priceFieldName(productId, size) {
  return `${productId}__${size}`;
}

// ── Step indicator ──
function renderStepIndicator() {
  const steps = [
    { num: 1, label: '기본정보' },
    { num: 2, label: '가격입력' },
    { num: 3, label: '사진/메모' }
  ];
  stepIndicator.innerHTML = steps.map((s, i) => {
    const cls = s.num === state.currentStep ? 'is-active' : (s.num < state.currentStep ? 'is-done' : '');
    const arrow = i < steps.length - 1 ? '<span class="step-arrow">\u2192</span>' : '';
    return `<span class="step ${cls}"><span class="step-num">${s.num < state.currentStep ? '\u2713' : s.num}</span>${s.label}</span>${arrow}`;
  }).join('');
}

// ── Multi-step form rendering ──
function renderForm(config) {
  state.currentStep = 1;
  state.photoDataUrl = '';
  state.selectedStoreType = config.storeTypeTemplates[0]?.label || '';
  surveyForm.classList.remove('hidden');
  successView.classList.add('hidden');
  renderStepIndicator();
  renderCurrentStep(config);

  // Update status bar researcher name
  const savedName = loadLocal('researcherName');
  if (savedName) statusResearcher.textContent = savedName;
}

function renderCurrentStep(config) {
  if (state.currentStep === 1) renderStep1(config);
  else if (state.currentStep === 2) renderStep2(config);
  else if (state.currentStep === 3) renderStep3(config);
  renderStepIndicator();
}

function renderStep1(config) {
  const savedName = loadLocal('researcherName');
  const savedResidence = loadLocal('residenceArea');
  const savedRegion = loadLocal('_step1_region');
  const savedStoreName = loadLocal('_step1_storeName');
  const savedPosCount = loadLocal('_step1_posCount') || '1';
  const savedDisplayLocation = loadLocal('_step1_displayLocation');
  const savedStoreType = loadLocal('_step1_storeType');
  if (savedStoreType) state.selectedStoreType = savedStoreType;

  formStepContainer.innerHTML = `
    <div class="card stack">
      <div class="field">
        <label>조사자 이름</label>
        <input name="researcherName" required value="${escapeHtml(savedName)}" placeholder="이름을 입력하세요" />
      </div>
      <div class="field">
        <label>거주 지역</label>
        <select name="residenceArea">
          ${config.areas.map((area) => `<option value="${area}" ${area === savedResidence ? 'selected' : ''}>${area}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>조사 지역</label>
        <button type="button" class="gps-btn" id="gps-fill-btn">
          \u{1F4CD} 현재 위치 사용
        </button>
        <input name="region" required placeholder="예: 강남" id="region-input" value="${escapeHtml(savedRegion)}" />
      </div>
      <div class="field">
        <label>거래처 유형</label>
        <div class="store-type-grid">
          ${config.storeTypeTemplates.map((t) => `<button type="button" class="store-type-btn ${t.label === state.selectedStoreType ? 'is-active' : ''}" data-store-type="${t.id}" data-label="${t.label}" data-pos="${t.defaultPosCount}">${t.label}</button>`).join('')}
        </div>
        <input type="hidden" name="storeType" value="${escapeHtml(state.selectedStoreType)}" />
      </div>
      <div class="field">
        <label>점포명</label>
        <input name="storeName" required placeholder="점포명을 입력하세요" value="${escapeHtml(savedStoreName)}" />
      </div>
      <div class="field">
        <label>POS 대수</label>
        <div class="stepper">
          <button type="button" id="pos-dec">&minus;</button>
          <span class="stepper-value" id="pos-display">${escapeHtml(savedPosCount)}</span>
          <button type="button" id="pos-inc">+</button>
        </div>
        <input type="hidden" name="posCount" value="${escapeHtml(savedPosCount)}" id="pos-input" />
      </div>
      <div class="field">
        <label>진열 위치</label>
        <input name="displayLocation" placeholder="예: 계산대 앞 / 냉장고 / 매대" value="${escapeHtml(savedDisplayLocation)}" />
      </div>
      <div class="form-nav">
        <button type="button" class="btn btn-primary" id="next-step1">다음 \u2192</button>
      </div>
    </div>
  `;

  // GPS fill button
  const gpsFillBtn = formStepContainer.querySelector('#gps-fill-btn');
  const regionInput = formStepContainer.querySelector('#region-input');
  gpsFillBtn.addEventListener('click', async () => {
    if (state.gps.status !== 'ready') {
      showToast('GPS 위치를 확인할 수 없습니다.', 'error');
      return;
    }
    gpsFillBtn.classList.add('is-loading');
    gpsFillBtn.textContent = '\u{1F4CD} 위치 확인 중...';
    try {
      const res = await fetch(`/api/reverse-geocode?lat=${state.gps.lat}&lng=${state.gps.lng}`);
      const data = await res.json();
      if (data.address) {
        regionInput.value = data.address;
        gpsFillBtn.textContent = '\u{1F4CD} 위치 입력 완료';
      } else {
        gpsFillBtn.textContent = '\u{1F4CD} 주소를 찾을 수 없습니다';
      }
    } catch {
      gpsFillBtn.textContent = '\u{1F4CD} 위치 확인 실패';
    }
    gpsFillBtn.classList.remove('is-loading');
  });

  // Store type buttons
  formStepContainer.querySelectorAll('.store-type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      formStepContainer.querySelectorAll('.store-type-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.selectedStoreType = btn.dataset.label;
      formStepContainer.querySelector('[name="storeType"]').value = btn.dataset.label;
      const posInput = formStepContainer.querySelector('#pos-input');
      const posDisplay = formStepContainer.querySelector('#pos-display');
      posInput.value = btn.dataset.pos;
      posDisplay.textContent = btn.dataset.pos;
    });
  });

  // POS stepper
  const posInput = formStepContainer.querySelector('#pos-input');
  const posDisplay = formStepContainer.querySelector('#pos-display');
  formStepContainer.querySelector('#pos-dec').addEventListener('click', () => {
    const v = Math.max(0, Number(posInput.value) - 1);
    posInput.value = v;
    posDisplay.textContent = v;
  });
  formStepContainer.querySelector('#pos-inc').addEventListener('click', () => {
    const v = Number(posInput.value) + 1;
    posInput.value = v;
    posDisplay.textContent = v;
  });

  // Next button
  formStepContainer.querySelector('#next-step1').addEventListener('click', () => {
    const name = formStepContainer.querySelector('[name="researcherName"]').value.trim();
    const region = formStepContainer.querySelector('[name="region"]').value.trim();
    const storeName = formStepContainer.querySelector('[name="storeName"]').value.trim();
    if (!name || !region || !storeName) {
      showToast('필수 항목을 입력해주세요.', 'error');
      return;
    }
    const residenceArea = formStepContainer.querySelector('[name="residenceArea"]').value;
    const storeType = formStepContainer.querySelector('[name="storeType"]')?.value || state.selectedStoreType || '';
    const posCount = formStepContainer.querySelector('[name="posCount"]')?.value || '1';
    const displayLocation = formStepContainer.querySelector('[name="displayLocation"]')?.value || '';

    // Save to both state AND localStorage for redundancy
    state.step1Data = { researcherName: name, residenceArea, region, storeType, storeName, posCount, displayLocation };
    saveLocal('researcherName', name);
    saveLocal('residenceArea', residenceArea);
    saveLocal('_step1_region', region);
    saveLocal('_step1_storeType', storeType);
    saveLocal('_step1_storeName', storeName);
    saveLocal('_step1_posCount', posCount);
    saveLocal('_step1_displayLocation', displayLocation);
    statusResearcher.textContent = name;
    state.currentStep = 2;
    renderCurrentStep(state.bootstrap);
  });
}

function renderStep2(config) {
  formStepContainer.innerHTML = `
    <div class="card stack">
      <div>
        <h3>제품별 가격 입력</h3>
        <p class="small">판매하지 않는 제품은 비워두세요. 최소 1개 이상의 가격을 입력해주세요.</p>
      </div>
      <div class="stack" id="product-list">
        ${config.products.map((product, idx) => `
          <div class="product-accordion ${idx === 0 ? 'is-open' : ''}" data-product="${product.id}">
            <div class="product-header">
              <div>
                <span class="product-name">${product.label}</span>
                <span class="product-brand">${product.brand}</span>
              </div>
              <span class="accordion-arrow">\u25BC</span>
            </div>
            <div class="product-body">
              ${product.sizes.map((size) => `
                <div class="price-field">
                  <span class="size-label">${size}</span>
                  <input inputmode="numeric" name="${priceFieldName(product.id, size)}" placeholder="\u20A9 가격" />
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
      <div class="form-nav">
        <button type="button" class="btn btn-secondary" id="prev-step2">\u2190 이전</button>
        <button type="button" class="btn btn-primary" id="next-step2">다음 \u2192</button>
      </div>
    </div>
  `;

  // Accordion toggle
  formStepContainer.querySelectorAll('.product-header').forEach((header) => {
    header.addEventListener('click', () => {
      header.closest('.product-accordion').classList.toggle('is-open');
    });
  });

  function savePrices() {
    const inputs = formStepContainer.querySelectorAll('.price-field input');
    const prices = {};
    inputs.forEach((i) => { if (i.value.trim()) prices[i.name] = i.value.trim(); });
    saveLocal('_step2_prices', JSON.stringify(prices));
  }

  function restorePrices() {
    try {
      const saved = JSON.parse(loadLocal('_step2_prices') || '{}');
      Object.entries(saved).forEach(([name, val]) => {
        const input = formStepContainer.querySelector(`input[name="${name}"]`);
        if (input) input.value = val;
      });
    } catch { /* ignore */ }
  }

  restorePrices();

  formStepContainer.querySelector('#prev-step2').addEventListener('click', () => {
    savePrices();
    state.currentStep = 1;
    renderCurrentStep(config);
  });

  formStepContainer.querySelector('#next-step2').addEventListener('click', () => {
    const inputs = formStepContainer.querySelectorAll('.price-field input');
    const hasPrice = [...inputs].some((i) => i.value.trim() !== '');
    if (!hasPrice) {
      showToast('최소 1개 이상의 가격을 입력해주세요.', 'error');
      return;
    }
    savePrices();
    state.currentStep = 3;
    renderCurrentStep(config);
  });
}

function renderStep3(config) {
  formStepContainer.innerHTML = `
    <div class="card stack">
      <div>
        <h3>사진 & 메모</h3>
      </div>
      <div class="field">
        <label>점포 사진</label>
        <div id="photo-area">
          <label class="camera-btn" id="camera-btn">
            <span class="camera-icon">\u{1F4F7}</span>
            <span>사진 촬영 / 선택</span>
            <input type="file" name="photo" accept="image/*" capture="environment" id="photo-input" />
          </label>
        </div>
      </div>
      <div class="field">
        <label>메모</label>
        <textarea name="notes" rows="4" placeholder="프로모션, 품절, 경쟁사 특이사항 등을 적어주세요">${escapeHtml(loadLocal('_step3_notes'))}</textarea>
      </div>
      <div class="form-nav">
        <button type="button" class="btn btn-secondary" id="prev-step3">\u2190 이전</button>
      </div>
      <button type="button" class="btn-submit" id="submit-btn">\u{1F4EE} 조사 저장</button>
      <div id="submit-status" class="small text-center"></div>
    </div>
  `;

  // Photo preview
  const photoInput = formStepContainer.querySelector('#photo-input');
  const photoArea = formStepContainer.querySelector('#photo-area');
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    if (!file) return;
    state.photoDataUrl = await fileToDataUrl(file);
    photoArea.innerHTML = `
      <div class="photo-preview-container">
        <img class="photo-preview" src="${state.photoDataUrl}" alt="미리보기" />
        <button type="button" class="photo-remove" id="photo-remove">\u2715</button>
      </div>
    `;
    photoArea.querySelector('#photo-remove').addEventListener('click', () => {
      state.photoDataUrl = '';
      photoArea.innerHTML = `
        <label class="camera-btn">
          <span class="camera-icon">\u{1F4F7}</span>
          <span>사진 촬영 / 선택</span>
          <input type="file" name="photo" accept="image/*" capture="environment" />
        </label>
      `;
    });
  });

  formStepContainer.querySelector('#prev-step3').addEventListener('click', () => {
    saveLocal('_step3_notes', formStepContainer.querySelector('[name="notes"]')?.value || '');
    state.currentStep = 2;
    renderCurrentStep(config);
  });

  formStepContainer.querySelector('#submit-btn').addEventListener('click', () => {
    handleSubmit(config);
  });
}

async function handleSubmit(config) {
  const submitBtn = formStepContainer.querySelector('#submit-btn');
  const statusEl = formStepContainer.querySelector('#submit-status');
  submitBtn.disabled = true;
  statusEl.textContent = '저장 중...';

  // Collect all form data across steps - read from hidden inputs + localStorage
  const formData = new FormData(surveyForm);
  const prices = [];
  for (const product of config.products) {
    for (const size of product.sizes) {
      const name = priceFieldName(product.id, size);
      const price = formData.get(name);
      if (price) {
        prices.push({ productId: product.id, productLabel: product.label, size, price });
      }
    }
  }

  // Read from both state.formData cache AND localStorage as fallback
  const s = state.step1Data || {};
  const payload = {
    researcher: {
      name: s.researcherName || loadLocal('researcherName') || '',
      residenceArea: s.residenceArea || loadLocal('residenceArea') || ''
    },
    survey: {
      region: s.region || loadLocal('_step1_region') || '',
      storeType: s.storeType || loadLocal('_step1_storeType') || '',
      storeName: s.storeName || loadLocal('_step1_storeName') || '',
      posCount: s.posCount || loadLocal('_step1_posCount') || '1',
      displayLocation: s.displayLocation || loadLocal('_step1_displayLocation') || ''
    },
    notes: formData.get('notes') || loadLocal('_step3_notes') || '',
    photoDataUrl: state.photoDataUrl,
    prices
  };

  // Include GPS coordinates in payload if available
  if (state.gps.status === 'ready') {
    payload.gpsLat = state.gps.lat;
    payload.gpsLng = state.gps.lng;
  }

  try {
    const response = await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) {
      statusEl.textContent = result.error || '저장에 실패했습니다.';
      submitBtn.disabled = false;
      return;
    }
    showSuccess(result);
    await loadBootstrap();
  } catch (err) {
    statusEl.textContent = '네트워크 오류가 발생했습니다.';
    submitBtn.disabled = false;
  }
}

function showSuccess(result) {
  surveyForm.classList.add('hidden');
  stepIndicator.innerHTML = '';
  successView.classList.remove('hidden');
  successView.innerHTML = `
    <div class="success-card">
      <div class="success-icon">\u2705</div>
      <h3>저장 완료!</h3>
      <div class="assigned-area">배정 지역: ${escapeHtml(result.assignment.currentArea)}</div>
      <div class="success-actions">
        <button type="button" class="btn btn-primary" id="new-survey">새 조사 시작</button>
        <button type="button" class="btn btn-secondary" id="view-history">조사 이력 보기</button>
      </div>
    </div>
  `;
  successView.querySelector('#new-survey').addEventListener('click', () => {
    renderForm(state.bootstrap);
  });
  successView.querySelector('#view-history').addEventListener('click', () => {
    navTabs.forEach((t) => t.classList.toggle('is-active', t.dataset.tab === 'admin'));
    panels.forEach((p) => p.classList.toggle('is-active', p.id === 'admin'));
  });
}

// ── Admin panel ──
function renderAdmin(config) {
  const submissions = config.submissions || [];
  const total = submissions.length;
  const today = new Date().toDateString();
  const todayCount = submissions.filter((s) => new Date(s.createdAt).toDateString() === today).length;
  const areaCounts = submissions.reduce((acc, s) => {
    const key = s.assignment.currentArea;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  adminStats.innerHTML = `
    <div class="stat-card">
      <span class="stat-value">${total}</span>
      <span class="stat-label">총 조사 수</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">${todayCount}</span>
      <span class="stat-label">오늘 조사</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">${Object.keys(areaCounts).length}</span>
      <span class="stat-label">활성 지역</span>
    </div>
  `;

  // Filters
  const researchers = [...new Set(submissions.map((s) => s.researcher.name))];
  adminFilter.innerHTML = `
    <input type="text" id="filter-name" placeholder="조사자 이름 검색" />
    <select id="filter-area">
      <option value="">전체 지역</option>
      ${config.areas.map((a) => `<option value="${a}">${a}</option>`).join('')}
    </select>
  `;
  const filterName = adminFilter.querySelector('#filter-name');
  const filterArea = adminFilter.querySelector('#filter-area');
  const doFilter = () => renderSubmissionList(config, submissions, filterName.value, filterArea.value);
  filterName.addEventListener('input', doFilter);
  filterArea.addEventListener('change', doFilter);

  renderSubmissionList(config, submissions, '', '');
}

function renderSubmissionList(config, submissions, nameFilter, areaFilter) {
  let filtered = submissions;
  if (nameFilter) {
    const q = nameFilter.toLowerCase();
    filtered = filtered.filter((s) => s.researcher.name.toLowerCase().includes(q));
  }
  if (areaFilter) {
    filtered = filtered.filter((s) => s.assignment.currentArea === areaFilter);
  }

  submissionList.innerHTML = filtered.length
    ? filtered.map((sub) => `
      <article class="submission-card">
        <div class="sub-header">
          <span class="store-name">${escapeHtml(sub.survey.storeName)}</span>
          <span class="sub-date">${new Date(sub.createdAt).toLocaleDateString('ko-KR')}</span>
        </div>
        <div class="sub-meta">
          ${escapeHtml(sub.researcher.name)} \u00B7 ${escapeHtml(sub.researcher.residenceArea)} \u2192 <strong>${escapeHtml(sub.assignment.currentArea)}</strong>
        </div>
        <div class="sub-meta">${escapeHtml(sub.survey.region)} \u00B7 ${escapeHtml(sub.survey.storeType)} \u00B7 POS ${sub.survey.posCount}</div>
        <div class="sub-prices">${sub.prices.map((p) => `${p.productLabel} ${p.size} \u20A9${p.price}`).join(', ')}</div>
        ${sub.photo ? `<img class="sub-photo" src="${sub.photo.url}" alt="${escapeHtml(sub.survey.storeName)}" />` : ''}
        <div class="sub-actions">
          <select data-submission-id="${sub.id}">
            ${config.areas.map((a) => `<option value="${a}" ${a === sub.assignment.currentArea ? 'selected' : ''}>${a}</option>`).join('')}
          </select>
          <button data-action="override" data-submission-id="${sub.id}">지역 변경</button>
        </div>
      </article>
    `).join('')
    : '<div class="notice">아직 등록된 조사 결과가 없습니다.</div>';

  submissionList.querySelectorAll('[data-action="override"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const select = submissionList.querySelector(`select[data-submission-id="${button.dataset.submissionId}"]`);
      const response = await fetch('/api/assignments/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submissionId: button.dataset.submissionId,
          assignedArea: select.value,
          reason: 'Admin override from MVP console',
          adminName: 'Admin console'
        })
      });
      if (response.ok) {
        await loadBootstrap();
      }
    });
  });
}

// ── Helpers ──
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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

// ── Map ──
const MARKER_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#34495e', '#d35400', '#c0392b'
];
const researcherColorMap = {};
let colorIndex = 0;

function getResearcherColor(name) {
  if (!researcherColorMap[name]) {
    researcherColorMap[name] = MARKER_COLORS[colorIndex % MARKER_COLORS.length];
    colorIndex++;
  }
  return researcherColorMap[name];
}

function createMarkerImage(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="36" viewBox="0 0 24 36"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24C24 5.4 18.6 0 12 0z" fill="${color}"/><circle cx="12" cy="12" r="5" fill="white"/></svg>`;
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return new kakao.maps.MarkerImage(
    src,
    new kakao.maps.Size(24, 36),
    { offset: new kakao.maps.Point(12, 36) }
  );
}

async function initMap() {
  if (!state.bootstrap) return;
  const container = document.getElementById('map-container');

  function createMap() {
    if (!state.mapInitialized) {
      const options = {
        center: new kakao.maps.LatLng(37.5665, 126.9780),
        level: 8
      };
      state.kakaoMap = new kakao.maps.Map(container, options);
      state.mapInitialized = true;
    } else {
      state.kakaoMap.relayout();
    }
    renderMapData();
  }

  if (typeof kakao === 'undefined' || typeof kakao.maps === 'undefined') {
    container.innerHTML = '<p style="padding:20px;color:#888;">카카오맵을 불러올 수 없습니다.</p>';
    return;
  }
  if (typeof kakao.maps.LatLng === 'undefined') {
    container.innerHTML = '<p style="padding:20px;color:#888;">카카오맵 로딩 중...</p>';
    kakao.maps.load(createMap);
    return;
  }
  createMap();
}

async function renderMapData() {
  const map = state.kakaoMap;
  const submissions = state.bootstrap.submissions;

  let statsData;
  try {
    const res = await fetch('/api/survey-stats');
    statsData = await res.json();
  } catch {
    statsData = { areas: [], totalSubmissions: 0 };
  }

  const bounds = new kakao.maps.LatLngBounds();
  let hasMarkers = false;
  const openInfoWindow = { current: null };

  submissions.forEach((sub) => {
    const lat = sub.lat || (sub.geocode && sub.geocode.lat) || (sub.survey?.coordinates?.lat) || (sub.researcher?.coordinates?.lat);
    const lng = sub.lng || (sub.geocode && sub.geocode.lng) || (sub.survey?.coordinates?.lng) || (sub.researcher?.coordinates?.lng);
    if (!lat || !lng) return;

    const color = getResearcherColor(sub.researcher.name);
    const position = new kakao.maps.LatLng(lat, lng);
    bounds.extend(position);
    hasMarkers = true;

    const marker = new kakao.maps.Marker({ map, position, image: createMarkerImage(color) });
    const priceCount = sub.prices ? sub.prices.length : 0;
    const date = new Date(sub.createdAt).toLocaleDateString('ko-KR');
    const content = `<div style="padding:8px 12px;font-size:13px;line-height:1.6;max-width:220px;">
      <strong>${sub.survey.storeName}</strong><br/>
      ${sub.researcher.name} \u00B7 ${date}<br/>
      ${sub.survey.storeType} \u00B7 가격 ${priceCount}건
    </div>`;

    const infoWindow = new kakao.maps.InfoWindow({ content });
    kakao.maps.event.addListener(marker, 'click', () => {
      if (openInfoWindow.current) openInfoWindow.current.close();
      infoWindow.open(map, marker);
      openInfoWindow.current = infoWindow;
    });
  });

  if (hasMarkers) map.setBounds(bounds);

  const legend = document.getElementById('map-legend');
  legend.innerHTML = Object.entries(researcherColorMap).map(([name, color]) =>
    `<div class="legend-item"><span class="legend-dot" style="background:${color}"></span>${name}</div>`
  ).join('');

  const coverageStats = document.getElementById('coverage-stats');
  if (statsData.areas && statsData.areas.length) {
    coverageStats.innerHTML = statsData.areas.map((a, i) => {
      const bg = MARKER_COLORS[i % MARKER_COLORS.length];
      return `<div class="summary-tile"><span class="coverage-badge" style="background:${bg}">${a.area}</span><strong>${a.count || a.submissionCount || 0}건</strong></div>`;
    }).join('');
  }
}

// ── Bootstrap ──
async function loadBootstrap() {
  const response = await fetch('/api/bootstrap');
  state.bootstrap = await response.json();
  renderForm(state.bootstrap);
  renderAdmin(state.bootstrap);
}

// Save step 1 field values to localStorage before navigating away
surveyForm.addEventListener('click', (e) => {
  if (e.target.id === 'next-step1') {
    // Save step 1 fields to localStorage for later retrieval during submit
    const container = formStepContainer;
    saveLocal('_step1_region', container.querySelector('[name="region"]')?.value || '');
    saveLocal('_step1_storeType', container.querySelector('[name="storeType"]')?.value || '');
    saveLocal('_step1_storeName', container.querySelector('[name="storeName"]')?.value || '');
    saveLocal('_step1_posCount', container.querySelector('[name="posCount"]')?.value || '1');
    saveLocal('_step1_displayLocation', container.querySelector('[name="displayLocation"]')?.value || '');
  }
});

// ── Init ──
initGps();
loadBootstrap();
