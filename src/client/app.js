const state = {
  bootstrap: null,
  mapInitialized: false,
  kakaoMap: null,
  gps: { lat: null, lng: null, status: 'pending' },
  currentStep: 1,
  photoDataUrl: '',
  selectedStoreType: '',
  pollTimer: null,
  previousBadgeIndex: -1
};

// ── DOM refs ──
const surveyForm = document.querySelector('#survey-form');
const formStepContainer = document.querySelector('#form-step-container');
const stepIndicator = document.querySelector('#step-indicator');
const successView = document.querySelector('#success-view');
const gpsStatusEl = document.querySelector('#gps-status');
const statusResearcher = document.querySelector('#status-researcher');
const navTabs = [...document.querySelectorAll('.nav-tab')];
const panels = [...document.querySelectorAll('.panel')];

// ── Navigation ──
navTabs.forEach((button) => {
  button.addEventListener('click', () => {
    navTabs.forEach((t) => t.classList.toggle('is-active', t === button));
    panels.forEach((p) => p.classList.toggle('is-active', p.id === button.dataset.tab));
    if (button.dataset.tab === 'dashboard') initMap();
  });
});

// ── Dashboard share link ──
const dashboardShareLink = document.querySelector('#dashboard-share');
if (dashboardShareLink) {
  dashboardShareLink.addEventListener('click', (e) => {
    e.preventDefault();
    shareIonroad('현장 시장조사를 더 쉽고 재밌게 — 이온로드 🏃');
  });
}

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
    pending: '\u{1F4CD} 위치 찾는 중...',
    ready: '\u{1F4CD} 위치 잡았어요!',
    unavailable: '\u{1F4CD} 위치를 못 찾았어요'
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

// ── Favorite stores ──
function getFavoriteStores() {
  try { return JSON.parse(localStorage.getItem('kwangdong_favoriteStores') || '[]'); } catch { return []; }
}
function saveFavoriteStores(stores) {
  try { localStorage.setItem('kwangdong_favoriteStores', JSON.stringify(stores.slice(-10))); } catch {}
}
function addFavoriteStore(store) {
  const stores = getFavoriteStores().filter((s) => s.storeName !== store.storeName);
  stores.push(store);
  saveFavoriteStores(stores);
}

// ── Price field naming ──
function priceFieldName(productId, size) {
  return `${productId}__${size}`;
}

// ── Step indicator ──
function renderStepIndicator() {
  const steps = [
    { num: 1, label: '기본정보' },
    { num: 2, label: '가격체크' },
    { num: 3, label: '마무리' }
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
        <label>이름 (누구세요? 😊)</label>
        <input name="researcherName" required value="${escapeHtml(savedName)}" placeholder="이름을 입력하세요" />
      </div>
      <div class="field">
        <label>거주 지역</label>
        <select name="residenceArea">
          ${config.areas.map((area) => `<option value="${area}" ${area === savedResidence ? 'selected' : ''}>${area}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>오늘 어디 다녀오셨어요?</label>
        <button type="button" class="gps-btn" id="gps-fill-btn">
          \u{1F4CD} 현재 위치 사용
        </button>
        <div class="address-search-wrap">
          <input name="region" required placeholder="주소를 검색하세요 (예: 강남역)" id="region-input" value="${escapeHtml(savedRegion)}" autocomplete="off" />
          <ul class="address-dropdown" id="address-dropdown"></ul>
        </div>
      </div>
      <div class="field">
        <label>어떤 매장이었나요?</label>
        <div class="store-type-grid">
          ${config.storeTypeTemplates.map((t) => `<button type="button" class="store-type-btn ${t.label === state.selectedStoreType ? 'is-active' : ''}" data-store-type="${t.id}" data-label="${t.label}" data-pos="${t.defaultPosCount}">${t.label}</button>`).join('')}
        </div>
        <input type="hidden" name="storeType" value="${escapeHtml(state.selectedStoreType)}" />
      </div>
      ${getFavoriteStores().length > 0 ? `
      <div class="field" id="favorite-stores-section">
        <label>\u2B50 자주 가는 매장</label>
        <div class="favorite-chips" style="display:flex;flex-wrap:wrap;gap:6px;">
          ${getFavoriteStores().map((f, i) => `<button type="button" class="btn btn-secondary favorite-chip" data-fav-idx="${i}" style="font-size:.85rem;padding:4px 12px;border-radius:16px;">${escapeHtml(f.storeName)}</button>`).join('')}
        </div>
      </div>` : ''}
      <div class="field">
        <label>매장 이름</label>
        <div class="address-search-wrap">
          <input name="storeName" required placeholder="예: GS25 역삼점, 이마트 강남점" value="${escapeHtml(savedStoreName)}" id="store-name-input" autocomplete="off" />
          <ul class="address-dropdown" id="store-name-dropdown"></ul>
        </div>
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
        <label>어디에 진열돼 있었어요?</label>
        <input name="displayLocation" placeholder="예: 계산대 앞 / 냉장고 / 매대" value="${escapeHtml(savedDisplayLocation)}" />
      </div>
      <div class="form-nav">
        <button type="button" class="btn btn-primary" id="next-step1">다음 \u2192</button>
      </div>
    </div>
  `;

  const gpsFillBtn = formStepContainer.querySelector('#gps-fill-btn');
  const regionInput = formStepContainer.querySelector('#region-input');
  gpsFillBtn.addEventListener('click', async () => {
    if (state.gps.status !== 'ready') {
      showToast('위치를 못 찾았어요 😅 주소를 직접 검색해주세요', 'error');
      regionInput.focus();
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
        gpsFillBtn.textContent = '\u{1F4CD} 주소를 찾을 수 없어요';
      }
    } catch {
      gpsFillBtn.textContent = '\u{1F4CD} 위치 확인 실패';
    }
    gpsFillBtn.classList.remove('is-loading');
  });

  // Address autocomplete via Kakao keyword search
  const dropdown = formStepContainer.querySelector('#address-dropdown');
  let searchTimer = null;

  regionInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = regionInput.value.trim();
    if (q.length < 2) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; return; }
    searchTimer = setTimeout(async () => {
      try {
        const res = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=5`, {
          headers: { Authorization: 'KakaoAK 082ce6eafadae8cfe01d6fc0859b158a' }
        });
        const data = await res.json();
        if (!data.documents?.length) { dropdown.innerHTML = '<li class="address-no-result">검색 결과가 없어요</li>'; dropdown.style.display = 'block'; return; }
        dropdown.innerHTML = data.documents.map((d) =>
          `<li class="address-item" data-address="${escapeHtml(d.address_name)}" data-place="${escapeHtml(d.place_name || '')}">
            <span class="address-place">${escapeHtml(d.place_name || d.address_name)}</span>
            <span class="address-detail">${escapeHtml(d.address_name)}</span>
          </li>`
        ).join('');
        dropdown.style.display = 'block';
      } catch { dropdown.style.display = 'none'; }
    }, 300);
  });

  dropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.address-item');
    if (!item) return;
    regionInput.value = item.dataset.address;
    dropdown.style.display = 'none';
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.address-search-wrap')) {
      dropdown.style.display = 'none';
      storeDropdown.style.display = 'none';
    }
  });

  // Store name autocomplete from bootstrap submissions
  const storeNameInput = formStepContainer.querySelector('#store-name-input');
  const storeDropdown = formStepContainer.querySelector('#store-name-dropdown');

  function getRecentStoreNames() {
    const subs = state.bootstrap?.submissions || [];
    const names = new Set();
    subs.forEach((s) => { if (s.survey?.storeName) names.add(s.survey.storeName); });
    return [...names];
  }

  storeNameInput.addEventListener('input', () => {
    const q = storeNameInput.value.trim().toLowerCase();
    if (q.length < 2) { storeDropdown.innerHTML = ''; storeDropdown.style.display = 'none'; return; }
    const matches = getRecentStoreNames().filter((n) => n.toLowerCase().includes(q));
    if (matches.length === 0) { storeDropdown.innerHTML = ''; storeDropdown.style.display = 'none'; return; }
    storeDropdown.innerHTML = matches.slice(0, 5).map((n) =>
      `<li class="address-item" data-store-name="${escapeHtml(n)}"><span class="address-place">${escapeHtml(n)}</span></li>`
    ).join('');
    storeDropdown.style.display = 'block';
  });

  storeDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.address-item');
    if (!item) return;
    storeNameInput.value = item.dataset.storeName;
    storeDropdown.style.display = 'none';
  });

  // Favorite store chips
  formStepContainer.querySelectorAll('.favorite-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const favs = getFavoriteStores();
      const fav = favs[Number(chip.dataset.favIdx)];
      if (!fav) return;
      // Fill store type
      const storeTypeBtn = formStepContainer.querySelector(`.store-type-btn[data-label="${fav.storeType}"]`);
      if (storeTypeBtn) {
        formStepContainer.querySelectorAll('.store-type-btn').forEach((b) => b.classList.remove('is-active'));
        storeTypeBtn.classList.add('is-active');
        state.selectedStoreType = fav.storeType;
        formStepContainer.querySelector('[name="storeType"]').value = fav.storeType;
        const posVal = storeTypeBtn.dataset.pos;
        formStepContainer.querySelector('#pos-input').value = posVal;
        formStepContainer.querySelector('#pos-display').textContent = posVal;
      }
      // Fill store name
      formStepContainer.querySelector('#store-name-input').value = fav.storeName;
      // Fill POS count
      if (fav.posCount) {
        formStepContainer.querySelector('#pos-input').value = fav.posCount;
        formStepContainer.querySelector('#pos-display').textContent = fav.posCount;
      }
      // Fill display location
      const dispInput = formStepContainer.querySelector('[name="displayLocation"]');
      if (dispInput && fav.displayLocation) dispInput.value = fav.displayLocation;
      showToast(`${fav.storeName} 정보를 불러왔어요!`, 'success');
    });
  });

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

  formStepContainer.querySelector('#next-step1').addEventListener('click', () => {
    const name = formStepContainer.querySelector('[name="researcherName"]').value.trim();
    const region = formStepContainer.querySelector('[name="region"]').value.trim();
    const storeName = formStepContainer.querySelector('[name="storeName"]').value.trim();
    if (!name || !region || !storeName) {
      showToast('앗, 빠진 항목이 있어요! 확인해주세요 🙏', 'error');
      return;
    }
    const residenceArea = formStepContainer.querySelector('[name="residenceArea"]').value;
    const storeType = formStepContainer.querySelector('[name="storeType"]')?.value || state.selectedStoreType || '';
    const posCount = formStepContainer.querySelector('[name="posCount"]')?.value || '1';
    const displayLocation = formStepContainer.querySelector('[name="displayLocation"]')?.value || '';

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
        <h3>가격 체크 💰</h3>
        <p class="small">없는 건 그냥 넘어가세요~ 있는 것만 적어주면 돼요 👌</p>
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
                  <input type="number" inputmode="numeric" pattern="[0-9]*" min="0" step="10" name="${priceFieldName(product.id, size)}" placeholder="\u20A9 가격" />
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
    savePrices();
    const inputs = formStepContainer.querySelectorAll('.price-field input');
    const hasAnyPrice = [...inputs].some((i) => i.value.trim());
    if (!hasAnyPrice) {
      showPriceReminder(config);
      return;
    }
    state.currentStep = 3;
    renderCurrentStep(config);
  });
}

function showPriceReminder(config) {
  const overlay = document.createElement('div');
  overlay.className = 'price-reminder-overlay';
  overlay.innerHTML = `
    <div class="price-reminder-dialog">
      <p>가격을 입력하지 않았어요. 괜찮으시면 다음으로 넘어갈게요 👌</p>
      <div class="price-reminder-actions">
        <button type="button" class="btn btn-secondary" id="reminder-skip">네, 넘어갈게요</button>
        <button type="button" class="btn btn-primary" id="reminder-input">가격 입력할게요</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#reminder-skip').addEventListener('click', () => {
    overlay.remove();
    state.currentStep = 3;
    renderCurrentStep(config);
  });

  overlay.querySelector('#reminder-input').addEventListener('click', () => {
    overlay.remove();
    const firstAccordion = formStepContainer.querySelector('.product-accordion');
    if (firstAccordion) {
      firstAccordion.classList.add('is-open');
      const firstInput = firstAccordion.querySelector('.price-field input');
      if (firstInput) firstInput.focus();
    }
  });
}

function renderStep3(config) {
  formStepContainer.innerHTML = `
    <div class="card stack">
      <div>
        <h3>마무리 📸</h3>
      </div>
      <div class="field">
        <label>매장 사진</label>
        <div id="photo-area">
          <label class="camera-btn" id="camera-btn">
            <span class="camera-icon">\u{1F4F7}</span>
            <span>📷 매장 사진 찍기</span>
            <input type="file" name="photo" accept="image/*" capture="environment" id="photo-input" />
          </label>
        </div>
      </div>
      <div class="field">
        <label>메모</label>
        <textarea name="notes" rows="4" placeholder="특이사항 있으면 자유롭게 적어주세요~ (프로모션, 품절, 경쟁사 동향 등)">${escapeHtml(loadLocal('_step3_notes'))}</textarea>
      </div>
      <div class="form-nav">
        <button type="button" class="btn btn-secondary" id="prev-step3">\u2190 이전</button>
      </div>
      <button type="button" class="btn-submit" id="submit-btn">✅ 기록 완료!</button>
      <div id="submit-status" class="small text-center"></div>
    </div>
  `;

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
          <span>📷 매장 사진 찍기</span>
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

  const s = state.step1Data || {};

  // Sanitize: trim whitespace, filter negative prices
  const sanitize = (v) => String(v || '').trim();
  const validPrices = prices.filter((p) => {
    const num = Number(String(p.price).replace(/[^0-9]/g, ''));
    return num > 0;
  });

  const payload = {
    researcher: {
      name: sanitize(s.researcherName || loadLocal('researcherName')),
      residenceArea: sanitize(s.residenceArea || loadLocal('residenceArea'))
    },
    survey: {
      region: sanitize(s.region || loadLocal('_step1_region')),
      storeType: sanitize(s.storeType || loadLocal('_step1_storeType')),
      storeName: sanitize(s.storeName || loadLocal('_step1_storeName')),
      posCount: s.posCount || loadLocal('_step1_posCount') || '1',
      displayLocation: sanitize(s.displayLocation || loadLocal('_step1_displayLocation'))
    },
    notes: sanitize(formData.get('notes') || loadLocal('_step3_notes')),
    photoDataUrl: state.photoDataUrl,
    prices: validPrices
  };

  if (state.gps.status === 'ready') {
    payload.gpsLat = state.gps.lat;
    payload.gpsLng = state.gps.lng;
  }

  // Offline queue: save locally if offline
  if (!navigator.onLine) {
    const queue = getPendingSubmissions();
    queue.push(payload);
    savePendingSubmissions(queue);
    showToast('📶 오프라인이에요. 연결되면 자동으로 저장할게요!', 'info');
    statusEl.textContent = '';
    submitBtn.disabled = false;
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const response = await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      if (response.status === 429) {
        statusEl.textContent = '요청이 너무 많아요. 잠시 후 다시 시도해주세요';
      } else if (response.status >= 500) {
        statusEl.textContent = '서버에 문제가 생겼어요. 잠시 후 다시 시도해주세요';
      } else if (response.status >= 400) {
        statusEl.textContent = '입력 데이터를 확인해주세요';
      } else {
        const result = await response.json().catch(() => ({}));
        statusEl.textContent = result.error || '저장에 실패했어요.';
      }
      submitBtn.disabled = false;
      return;
    }
    const result = await response.json();
    // Clear temporary localStorage keys (keep researcherName, residenceArea)
    ['_step1_region', '_step1_storeType', '_step1_storeName', '_step1_posCount', '_step1_displayLocation', '_step2_prices', '_step3_notes'].forEach((k) => {
      try { localStorage.removeItem('kwangdong_' + k); } catch {}
    });
    state.photoDataUrl = '';
    // Check badge before reload
    const oldBadgeIdx = state.previousBadgeIndex;
    showSuccess(result);
    // Ask to add to favorites
    promptFavoriteStore(state.step1Data);
    await loadBootstrap();
    // Check if badge upgraded
    const newSubs = getMySubmissions(state.bootstrap.submissions || []);
    const newBadgeIdx = getBadgeIndex(newSubs.length);
    if (newBadgeIdx > oldBadgeIdx && newBadgeIdx >= 0) {
      const newBadge = BADGES[newBadgeIdx];
      // Show badge with bounce animation in success view
      const badgeEl = document.createElement('div');
      badgeEl.className = 'badge-bounce';
      badgeEl.style.cssText = 'font-size:2rem;text-align:center;margin-top:8px;';
      badgeEl.textContent = `${newBadge.emoji} ${newBadge.label}`;
      const successCard = successView.querySelector('.success-card');
      if (successCard) successCard.insertBefore(badgeEl, successCard.querySelector('.success-actions'));
      showToast(`🎉 축하해요! ${newBadge.label} 뱃지를 획득했어요!`, 'success');
    }
    state.previousBadgeIndex = newBadgeIdx;
    // 대시보드 자동 갱신 후 탭 전환
    navTabs.forEach((t) => t.classList.toggle('is-active', t.dataset.tab === 'dashboard'));
    panels.forEach((p) => p.classList.toggle('is-active', p.id === 'dashboard'));
    initMap();
  } catch (err) {
    if (err.name === 'AbortError') {
      statusEl.textContent = '시간 초과. 다시 시도해주세요 ⏱️';
    } else {
      statusEl.textContent = '인터넷 연결을 확인해주세요 📶';
    }
    submitBtn.disabled = false;
  }
}

function promptFavoriteStore(step1Data) {
  if (!step1Data || !step1Data.storeName) return;
  const existing = getFavoriteStores();
  if (existing.some((s) => s.storeName === step1Data.storeName)) return;
  const overlay = document.createElement('div');
  overlay.className = 'price-reminder-overlay';
  overlay.innerHTML = `
    <div class="price-reminder-dialog">
      <p>\u2B50 <strong>${escapeHtml(step1Data.storeName)}</strong>을(를) 즐겨찾기에 추가할까요?</p>
      <p class="small">다음에 더 빠르게 기록할 수 있어요!</p>
      <div class="price-reminder-actions">
        <button type="button" class="btn btn-secondary" id="fav-no">괜찮아요</button>
        <button type="button" class="btn btn-primary" id="fav-yes">추가할게요!</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#fav-no').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#fav-yes').addEventListener('click', () => {
    addFavoriteStore({
      storeType: step1Data.storeType || '',
      storeName: step1Data.storeName,
      posCount: step1Data.posCount || '1',
      displayLocation: step1Data.displayLocation || ''
    });
    showToast(`${step1Data.storeName} 즐겨찾기 추가! \u2B50`, 'success');
    overlay.remove();
  });
}

function showSuccess(result) {
  surveyForm.classList.add('hidden');
  stepIndicator.innerHTML = '';
  successView.classList.remove('hidden');

  const storeName = (state.step1Data && state.step1Data.storeName) || '매장';

  successView.innerHTML = `
    <style>
      .success-check { font-size: 3rem; animation: successPop .5s cubic-bezier(.17,.67,.24,1.3) both; }
      @keyframes successPop { 0% { transform: scale(0); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
      .confetti-wrap { position: relative; height: 0; overflow: visible; pointer-events: none; }
      .confetti-piece { position: absolute; width: 8px; height: 8px; border-radius: 2px; opacity: 0; animation: confettiFall 1.2s ease-out forwards; }
      @keyframes confettiFall { 0% { transform: translateY(-30px) rotate(0deg); opacity: 1; } 100% { transform: translateY(60px) rotate(360deg); opacity: 0; } }
      .badge-bounce { display: inline-block; animation: badgeBounce .6s ease .4s both; }
      @keyframes badgeBounce { 0% { transform: scale(0); } 60% { transform: scale(1.3); } 100% { transform: scale(1); } }
      .share-btn { margin-top: 8px; background: none; border: 1px solid var(--border, #ddd); border-radius: 8px; padding: 8px 16px; cursor: pointer; font-size: .9rem; color: inherit; }
      .share-btn:active { opacity: .7; }
    </style>
    <div class="success-card">
      <div class="confetti-wrap" id="confetti-wrap"></div>
      <div class="success-check">✅</div>
      <h3>수고했어요!</h3>
      <div class="assigned-area">다음 추천 지역: ${escapeHtml(result.assignment.currentArea)}</div>
      <div class="success-actions">
        <button type="button" class="btn btn-primary" id="new-survey">한 곳 더 갈래요? 🏃</button>
        <button type="button" class="btn btn-secondary" id="view-history">오늘 기록 보기 📋</button>
        <button type="button" class="share-btn" id="share-success">📤 오늘 기록 공유하기</button>
      </div>
    </div>
  `;

  // Confetti particles
  const confettiWrap = successView.querySelector('#confetti-wrap');
  const colors = ['#f39c12', '#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#e67e22'];
  for (let i = 0; i < 12; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-delay:${Math.random() * 0.4}s;`;
    confettiWrap.appendChild(piece);
  }

  successView.querySelector('#new-survey').addEventListener('click', () => {
    renderForm(state.bootstrap);
  });
  successView.querySelector('#view-history').addEventListener('click', () => {
    navTabs.forEach((t) => t.classList.toggle('is-active', t.dataset.tab === 'dashboard'));
    panels.forEach((p) => p.classList.toggle('is-active', p.id === 'dashboard'));
    initMap();
  });
  successView.querySelector('#share-success').addEventListener('click', () => {
    shareIonroad(`오늘 ${escapeHtml(storeName)}에서 시장조사 완료! 이온로드로 간편 기록 중 📋`);
  });
}

// ── Dashboard stats helpers ──
function calcProductStats(submissions, products) {
  const totalStores = submissions.length;
  if (!totalStores) return [];

  return products.map((product) => {
    const storesWithProduct = submissions.filter((sub) =>
      sub.prices && sub.prices.some((p) => p.productId === product.id)
    );
    const discoveryRate = totalStores > 0 ? storesWithProduct.length / totalStores : 0;

    const sizeStats = {};
    product.sizes.forEach((size) => {
      const pricesForSize = [];
      storesWithProduct.forEach((sub) => {
        sub.prices.forEach((p) => {
          if (p.productId === product.id && p.size === size && p.price) {
            const num = Number(String(p.price).replace(/[^0-9]/g, ''));
            if (num > 0) pricesForSize.push(num);
          }
        });
      });
      if (pricesForSize.length > 0) {
        sizeStats[size] = {
          avg: Math.round(pricesForSize.reduce((a, b) => a + b, 0) / pricesForSize.length),
          min: Math.min(...pricesForSize),
          max: Math.max(...pricesForSize),
          count: pricesForSize.length
        };
      }
    });

    return {
      id: product.id,
      label: product.label,
      brand: product.brand,
      discoveryRate,
      storeCount: storesWithProduct.length,
      totalStores,
      sizeStats
    };
  }).sort((a, b) => b.discoveryRate - a.discoveryRate);
}

function calcAreaStats(submissions, areas) {
  const areaMap = {};
  areas.forEach((a) => { areaMap[a] = { name: a, count: 0, products: {} }; });

  submissions.forEach((sub) => {
    const area = sub.assignment?.currentArea;
    if (!area) return;
    if (!areaMap[area]) areaMap[area] = { name: area, count: 0, products: {} };
    areaMap[area].count++;
    if (sub.prices) {
      sub.prices.forEach((p) => {
        areaMap[area].products[p.productLabel] = (areaMap[area].products[p.productLabel] || 0) + 1;
      });
    }
  });

  return Object.values(areaMap).map((a) => {
    const sorted = Object.entries(a.products).sort((x, y) => y[1] - x[1]);
    return { ...a, topProduct: sorted[0] ? sorted[0][0] : '-' };
  });
}

function calcTodayCount(submissions) {
  const today = new Date().toDateString();
  return submissions.filter((s) => new Date(s.createdAt).toDateString() === today).length;
}

function calcRecentActivity(submissions, limit) {
  const sorted = [...submissions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return sorted.slice(0, limit).map((sub) => {
    const priceCount = sub.prices ? sub.prices.length : 0;
    return {
      name: sub.researcher.name,
      storeName: sub.survey.storeName,
      storeType: sub.survey.storeType,
      priceCount,
      createdAt: sub.createdAt
    };
  });
}

function relativeTime(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '어제';
  return `${days}일 전`;
}

// ── Badge system ──
const BADGES = [
  { emoji: '🌱', label: '새싹', min: 1, max: 2 },
  { emoji: '🌿', label: '성장', min: 3, max: 4 },
  { emoji: '🌳', label: '베테랑', min: 5, max: 9 },
  { emoji: '⭐', label: '스타', min: 10, max: 19 },
  { emoji: '🏆', label: '챔피언', min: 20, max: Infinity }
];

function getBadgeIndex(count) {
  return BADGES.findIndex((b) => count >= b.min && count <= b.max);
}

function getMySubmissions(submissions) {
  const myName = loadLocal('researcherName');
  if (!myName) return [];
  return submissions.filter((s) => s.researcher.name === myName);
}

function renderMyAchievement(submissions) {
  let container = document.querySelector('#my-achievement');
  if (!container) {
    container = document.createElement('div');
    container.id = 'my-achievement';
    const quickStats = document.querySelector('#quick-stats');
    quickStats.parentNode.insertBefore(container, quickStats.nextSibling);
  }

  const myName = loadLocal('researcherName');
  if (!myName) { container.innerHTML = ''; return; }

  const mySubs = getMySubmissions(submissions);
  const count = mySubs.length;
  const badgeIdx = getBadgeIndex(count);
  const badge = badgeIdx >= 0 ? BADGES[badgeIdx] : null;

  // Update previous badge index for comparison
  if (state.previousBadgeIndex === -1) {
    state.previousBadgeIndex = badgeIdx;
  }

  // Next badge info
  let nextBadgeHtml = '';
  const nextIdx = badgeIdx + 1;
  if (nextIdx < BADGES.length) {
    const next = BADGES[nextIdx];
    const remaining = next.min - count;
    nextBadgeHtml = `<div class="achievement-next">${next.emoji} ${next.label}까지 ${remaining}건 남았어요!</div>`;
  } else if (badgeIdx === BADGES.length - 1) {
    nextBadgeHtml = '<div class="achievement-next achievement-max">최고 등급 달성!</div>';
  }

  // Progress bar
  let progressPct = 0;
  if (badge) {
    const rangeSize = badge.max === Infinity ? badge.min : (badge.max - badge.min + 1);
    const inRange = count - badge.min;
    progressPct = badge.max === Infinity ? 100 : Math.min(100, Math.round((inRange / rangeSize) * 100));
  }

  container.innerHTML = `
    <div class="achievement-card" style="margin-top:12px;">
      <div class="achievement-header">
        <span class="achievement-badge-emoji">${badge ? badge.emoji : '🌱'}</span>
        <div class="achievement-info">
          <div class="achievement-name">${escapeHtml(myName)}님의 기록</div>
          <div class="achievement-count">${count}건 ${badge ? `· ${badge.label}` : ''}</div>
        </div>
      </div>
      <div class="achievement-progress-track">
        <div class="achievement-progress-fill" style="width:${progressPct}%"></div>
      </div>
      ${nextBadgeHtml}
    </div>
  `;
}

function renderMyRecords(submissions) {
  let container = document.querySelector('#my-records');
  if (!container) {
    container = document.createElement('div');
    container.id = 'my-records';
    container.style.marginTop = '12px';
    const recentActivity = document.querySelector('#recent-activity');
    recentActivity.parentNode.insertBefore(container, recentActivity.nextSibling);
  }

  const myName = loadLocal('researcherName');
  if (!myName) { container.innerHTML = ''; return; }

  const mySubs = getMySubmissions(submissions);
  const sorted = [...mySubs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (sorted.length === 0) {
    container.innerHTML = `
      <div class="card stack">
        <h2>내 기록 📋</h2>
        <div class="empty-state">
          <div class="empty-icon">🏃</div>
          <p>아직 기록이 없어요</p>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="card stack">
      <h2>내 기록 📋</h2>
      <div class="my-records-list">
        ${sorted.map((sub) => {
    const date = new Date(sub.createdAt).toLocaleDateString('ko-KR');
    const priceCount = sub.prices ? sub.prices.length : 0;
    return `
            <div class="my-record-item">
              <div class="my-record-main">
                <span class="my-record-store">${escapeHtml(sub.survey.storeName)}</span>
                <span class="my-record-date">${date}</span>
              </div>
              <div class="my-record-meta">가격 ${priceCount}건</div>
            </div>
          `;
  }).join('')}
      </div>
    </div>
  `;
}

// ── Photo Gallery ──
function renderPhotoGallery(submissions) {
  let container = document.querySelector('#photo-gallery');
  if (!container) {
    container = document.createElement('div');
    container.id = 'photo-gallery';
    container.style.marginTop = '12px';
    const myRecords = document.querySelector('#my-records');
    if (myRecords) {
      myRecords.parentNode.insertBefore(container, myRecords.nextSibling);
    } else {
      const recentActivity = document.querySelector('#recent-activity');
      if (recentActivity) recentActivity.parentNode.insertBefore(container, recentActivity.nextSibling);
    }
  }

  const mySubs = getMySubmissions(submissions);
  const photosData = mySubs
    .filter((s) => s.photoDataUrl)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 12)
    .map((s) => ({
      url: s.photoDataUrl,
      storeName: s.survey.storeName,
      date: new Date(s.createdAt).toLocaleDateString('ko-KR')
    }));

  if (photosData.length === 0) {
    container.innerHTML = `
      <div class="card stack">
        <h2>\u{1F4F8} 최근 사진</h2>
        <div class="empty-state">
          <div class="empty-icon">\u{1F4F7}</div>
          <p>아직 사진이 없어요 \u{1F4F7} 매장 사진을 찍어보세요!</p>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="card stack">
      <h2>\u{1F4F8} 최근 사진</h2>
      <div class="photo-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
        ${photosData.map((p, i) => `<div class="photo-thumb" data-photo-idx="${i}" style="width:100%;aspect-ratio:1;overflow:hidden;border-radius:8px;cursor:pointer;"><img src="${p.url}" alt="${escapeHtml(p.storeName)}" style="width:100%;height:100%;object-fit:cover;" /></div>`).join('')}
      </div>
    </div>
  `;

  // Lightbox
  container.querySelectorAll('.photo-thumb').forEach((thumb) => {
    thumb.addEventListener('click', () => {
      openLightbox(photosData, Number(thumb.dataset.photoIdx));
    });
  });
}

function openLightbox(photos, startIdx) {
  let idx = startIdx;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.9);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;';

  function render() {
    const p = photos[idx];
    overlay.innerHTML = `
      <div style="position:absolute;top:12px;right:16px;color:#fff;font-size:1.5rem;cursor:pointer;z-index:10001;" id="lb-close">\u2715</div>
      ${photos.length > 1 ? `<div style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#fff;font-size:2rem;cursor:pointer;z-index:10001;padding:8px;" id="lb-prev">\u2039</div>` : ''}
      ${photos.length > 1 ? `<div style="position:absolute;right:12px;top:50%;transform:translateY(-50%);color:#fff;font-size:2rem;cursor:pointer;z-index:10001;padding:8px;" id="lb-next">\u203A</div>` : ''}
      <img src="${p.url}" alt="${escapeHtml(p.storeName)}" style="max-width:90%;max-height:75vh;border-radius:8px;object-fit:contain;" />
      <div style="color:#fff;text-align:center;margin-top:12px;font-size:.9rem;">
        <strong>${escapeHtml(p.storeName)}</strong><br/>${p.date}
      </div>
    `;
    overlay.querySelector('#lb-close').addEventListener('click', () => overlay.remove());
    const prevBtn = overlay.querySelector('#lb-prev');
    const nextBtn = overlay.querySelector('#lb-next');
    if (prevBtn) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); idx = (idx - 1 + photos.length) % photos.length; render(); });
    if (nextBtn) nextBtn.addEventListener('click', (e) => { e.stopPropagation(); idx = (idx + 1) % photos.length; render(); });
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // Swipe support
  let touchStartX = 0;
  overlay.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; });
  overlay.addEventListener('touchend', (e) => {
    const diff = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(diff) > 50 && photos.length > 1) {
      idx = diff > 0 ? (idx - 1 + photos.length) % photos.length : (idx + 1) % photos.length;
      render();
    }
  });

  render();
  document.body.appendChild(overlay);
}

// ── Dashboard rendering ──
function renderDashboard(config) {
  const submissions = config.submissions || [];
  const products = config.products || [];
  const areas = config.areas || [];
  const total = submissions.length;
  const todayCount = calcTodayCount(submissions);
  const uniqueResearchers = new Set(submissions.map((s) => s.researcher.name)).size;
  const coveredAreas = new Set(submissions.map((s) => s.assignment?.currentArea).filter(Boolean)).size;

  // 1. Quick Stats
  if (total === 0) {
    document.querySelector('#quick-stats').innerHTML = `
      <div class="empty-state" style="width:100%;">
        <div class="empty-icon">🏃</div>
        <p>아직 기록이 없어요<br/>첫 번째 기록을 남겨볼까요?</p>
      </div>
    `;
  } else {
    document.querySelector('#quick-stats').innerHTML = `
      <div class="quick-stat"><span class="qs-icon">🏃</span><span class="qs-value">${total}</span><span class="qs-label">총 기록</span></div>
      <div class="quick-stat"><span class="qs-icon">📅</span><span class="qs-value">${todayCount}</span><span class="qs-label">오늘</span></div>
      <div class="quick-stat"><span class="qs-icon">👤</span><span class="qs-value">${uniqueResearchers}</span><span class="qs-label">조사자</span></div>
      <div class="quick-stat"><span class="qs-icon">📍</span><span class="qs-value">${coveredAreas}/${areas.length}</span><span class="qs-label">지역</span></div>
    `;
  }

  // 3. Product Leaderboard
  const productStats = calcProductStats(submissions, products);
  const medals = ['🥇', '🥈', '🥉'];
  const leaderboard = document.querySelector('#product-leaderboard');
  leaderboard.innerHTML = `
    <h2>제품 현황판 🏆</h2>
    ${productStats.length === 0 ? '<div class="empty-state"><div class="empty-icon">🏆</div><p>데이터가 쌓이면 제품 순위가 표시돼요!</p></div>' : productStats.map((ps, i) => {
      const pct = Math.round(ps.discoveryRate * 100);
      const medal = i < 3 ? medals[i] : '';
      const isIonKick = ps.id === 'ion-kick';
      const barColor = isIonKick ? 'var(--gold)' : 'var(--primary)';
      const cardClass = isIonKick ? 'product-stat-card is-highlight' : 'product-stat-card';
      const sizesHtml = Object.entries(ps.sizeStats).map(([size, stats]) =>
        `<div class="ps-size"><span class="ps-size-label">${size}</span> 평균 ₩${stats.avg.toLocaleString()} <span class="ps-range">(₩${stats.min.toLocaleString()}~₩${stats.max.toLocaleString()})</span></div>`
      ).join('');
      return `
        <div class="${cardClass}">
          <div class="ps-header">
            <span class="ps-name">${medal} ${ps.label}</span>
            <span class="ps-rate">발견률 ${pct}%</span>
          </div>
          <div class="ps-bar-track">
            <div class="ps-bar-fill" style="width:${pct}%;background:${barColor}"></div>
          </div>
          <div class="ps-detail">${ps.storeCount}/${ps.totalStores}개 매장</div>
          ${sizesHtml ? `<div class="ps-sizes">${sizesHtml}</div>` : ''}
        </div>
      `;
    }).join('')}
  `;

  // 4. Area Stats
  const areaStats = calcAreaStats(submissions, areas);
  const areaGrid = document.querySelector('#area-stats-grid');
  if (areaStats.some((a) => a.count > 0)) {
    areaGrid.innerHTML = `
      <div class="card stack">
        <h2>지역별 현황 📍</h2>
        <div class="area-cards">
          ${areaStats.map((a) => `
            <div class="area-card">
              <div class="area-name">${escapeHtml(a.name)}</div>
              <div class="area-count">${a.count}건</div>
              <div class="area-top">인기 제품: <strong>${escapeHtml(a.topProduct)}</strong></div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } else {
    areaGrid.innerHTML = '';
  }

  // 5. Recent Activity
  const recent = calcRecentActivity(submissions, 5);
  const activityEl = document.querySelector('#recent-activity');
  if (recent.length > 0) {
    activityEl.innerHTML = `
      <h2>최근 활동 🕐</h2>
      <div class="activity-feed">
        ${recent.map((r) => `
          <div class="activity-item">
            <div class="activity-dot"></div>
            <div class="activity-text">
              <strong>${escapeHtml(r.name)}</strong>님이 ${escapeHtml(r.storeName)}에서 기록
              <span class="activity-time">${relativeTime(r.createdAt)}</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } else {
    activityEl.innerHTML = '<h2>최근 활동 🕐</h2><p class="small">아직 활동이 없어요.</p>';
  }

  // 6. My Achievement Card
  renderMyAchievement(submissions);

  // 7. My Records
  renderMyRecords(submissions);

  // 8. Photo Gallery
  renderPhotoGallery(submissions);
}

// ── Helpers ──
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1280;
      let w = img.width;
      let h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => reject(new Error('이미지를 불러올 수 없어요'));
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
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

async function shareIonroad(text) {
  const shareData = {
    title: '이온로드 🏃',
    text,
    url: window.location.origin
  };
  if (navigator.share) {
    try { await navigator.share(shareData); } catch { /* user cancelled */ }
  } else {
    try {
      await navigator.clipboard.writeText(`${text}\n${window.location.origin}`);
      showToast('링크가 복사됐어요! 📋', 'success');
    } catch {
      showToast('공유에 실패했어요', 'error');
    }
  }
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
    container.innerHTML = '<p style="padding:20px;color:#888;">카카오맵을 불러올 수 없어요.</p>';
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

  // Clear previous clusterer
  if (state.mapClusterer) { state.mapClusterer.clear(); }

  const bounds = new kakao.maps.LatLngBounds();
  let hasMarkers = false;
  const openInfoWindow = { current: null };
  const markers = [];

  submissions.forEach((sub) => {
    const lat = sub.lat || (sub.geocode && sub.geocode.lat) || (sub.survey?.coordinates?.lat) || (sub.researcher?.coordinates?.lat);
    const lng = sub.lng || (sub.geocode && sub.geocode.lng) || (sub.survey?.coordinates?.lng) || (sub.researcher?.coordinates?.lng);
    if (!lat || !lng) return;

    const color = getResearcherColor(sub.researcher.name);
    const position = new kakao.maps.LatLng(lat, lng);
    bounds.extend(position);
    hasMarkers = true;

    const marker = new kakao.maps.Marker({ position, image: createMarkerImage(color) });
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
    markers.push(marker);
  });

  // Cluster markers for grouping & distribution view
  state.mapClusterer = new kakao.maps.MarkerClusterer({
    map,
    averageCenter: true,
    minLevel: 4,
    disableClickZoom: false,
    styles: [
      { width: '40px', height: '40px', background: 'rgba(32,137,92,0.75)', borderRadius: '50%', color: '#fff', textAlign: 'center', fontWeight: '700', lineHeight: '40px', fontSize: '14px' },
      { width: '50px', height: '50px', background: 'rgba(32,137,92,0.85)', borderRadius: '50%', color: '#fff', textAlign: 'center', fontWeight: '700', lineHeight: '50px', fontSize: '16px' },
      { width: '60px', height: '60px', background: 'rgba(32,137,92,0.95)', borderRadius: '50%', color: '#fff', textAlign: 'center', fontWeight: '700', lineHeight: '60px', fontSize: '18px' }
    ]
  });
  state.mapClusterer.addMarkers(markers);

  if (hasMarkers) map.setBounds(bounds);

  const legend = document.getElementById('map-legend');
  legend.innerHTML = Object.entries(researcherColorMap).map(([name, color]) =>
    `<div class="legend-item"><span class="legend-dot" style="background:${color}"></span>${name}</div>`
  ).join('');
}

// ── Bootstrap ──
async function loadBootstrap() {
  const response = await fetch('/api/bootstrap');
  state.bootstrap = await response.json();
  renderForm(state.bootstrap);
  renderDashboard(state.bootstrap);
}

// Save step 1 field values to localStorage before navigating away
surveyForm.addEventListener('click', (e) => {
  if (e.target.id === 'next-step1') {
    const container = formStepContainer;
    saveLocal('_step1_region', container.querySelector('[name="region"]')?.value || '');
    saveLocal('_step1_storeType', container.querySelector('[name="storeType"]')?.value || '');
    saveLocal('_step1_storeName', container.querySelector('[name="storeName"]')?.value || '');
    saveLocal('_step1_posCount', container.querySelector('[name="posCount"]')?.value || '1');
    saveLocal('_step1_displayLocation', container.querySelector('[name="displayLocation"]')?.value || '');
  }
});

// ── Onboarding ──
function initOnboarding() {
  if (loadLocal('onboarded')) return;
  const overlay = document.getElementById('onboarding-overlay');
  const slides = overlay.querySelectorAll('.onboarding-slide');
  const dots = overlay.querySelectorAll('.onboarding-dots .dot');
  const nextBtn = document.getElementById('onboarding-next');
  const skipBtn = document.getElementById('onboarding-skip');
  const nameInput = document.getElementById('onboarding-name');
  let current = 0;

  // Pre-fill name if exists
  const savedName = loadLocal('researcherName');
  if (savedName) nameInput.value = savedName;

  overlay.classList.remove('hidden');

  function goTo(idx) {
    slides.forEach((s, i) => s.classList.toggle('is-active', i === idx));
    dots.forEach((d, i) => d.classList.toggle('is-active', i === idx));
    current = idx;
    nextBtn.textContent = idx === 2 ? '시작하기!' : '다음';
  }

  nextBtn.addEventListener('click', () => {
    if (current < 2) {
      goTo(current + 1);
      if (current === 2) nameInput.focus();
    } else {
      finishOnboarding();
    }
  });

  skipBtn.addEventListener('click', finishOnboarding);

  function finishOnboarding() {
    const name = nameInput.value.trim();
    if (name) {
      saveLocal('researcherName', name);
      statusResearcher.textContent = name;
    }
    saveLocal('onboarded', 'true');
    overlay.classList.add('hidden');
  }
}

// ── Help Sheet ──
function initHelpSheet() {
  const fab = document.getElementById('help-fab');
  const sheet = document.getElementById('help-sheet');
  const backdrop = document.getElementById('help-backdrop');

  function open() { sheet.classList.remove('hidden'); backdrop.classList.remove('hidden'); }
  function close() { sheet.classList.add('hidden'); backdrop.classList.add('hidden'); }

  fab.addEventListener('click', open);
  backdrop.addEventListener('click', close);
}

// ── Dashboard auto-refresh (30s polling) ──
function getActiveTab() {
  const active = navTabs.find((t) => t.classList.contains('is-active'));
  return active ? active.dataset.tab : '';
}

function startDashboardPolling() {
  stopDashboardPolling();
  state.pollTimer = setInterval(async () => {
    if (document.hidden) return;
    if (getActiveTab() !== 'dashboard') return;
    try {
      const response = await fetch('/api/bootstrap');
      const data = await response.json();
      const oldCount = (state.bootstrap?.submissions || []).length;
      const newCount = (data.submissions || []).length;
      state.bootstrap = data;
      if (newCount !== oldCount) {
        renderDashboard(state.bootstrap);
      }
    } catch { /* silent fail on poll */ }
  }, 30000);
}

function stopDashboardPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && getActiveTab() === 'dashboard') {
    startDashboardPolling();
  }
});

// ── Global error handling ──
window.onerror = function (msg, source, line, col, error) {
  console.error('Global error:', { msg, source, line, col, error });
  showToast('문제가 생겼어요 😅 새로고침 해주세요', 'error');
};
window.onunhandledrejection = function (event) {
  console.error('Unhandled rejection:', event.reason);
  showToast('문제가 생겼어요 😅 새로고침 해주세요', 'error');
};

// ── Offline submission queue ──
function getPendingSubmissions() {
  try {
    return JSON.parse(localStorage.getItem('kwangdong_pendingSubmissions') || '[]');
  } catch { return []; }
}

function savePendingSubmissions(queue) {
  try { localStorage.setItem('kwangdong_pendingSubmissions', JSON.stringify(queue)); } catch {}
}

async function flushPendingSubmissions() {
  const queue = getPendingSubmissions();
  if (queue.length === 0) return;
  let flushed = 0;
  const remaining = [];
  for (const item of queue) {
    try {
      const response = await fetch('/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item)
      });
      if (response.ok) {
        flushed++;
      } else {
        remaining.push(item);
      }
    } catch {
      remaining.push(item);
    }
  }
  savePendingSubmissions(remaining);
  if (flushed > 0) {
    showToast(`오프라인 기록 ${flushed}건 저장 완료! ✅`, 'success');
    await loadBootstrap();
  }
}

window.addEventListener('online', () => {
  flushPendingSubmissions();
});

// ── Page unload warning ──
window.addEventListener('beforeunload', (e) => {
  if (state.currentStep > 1) {
    e.preventDefault();
    e.returnValue = '작성 중인 내용이 있어요';
  }
});

// ── Init ──
initGps();
loadBootstrap();
initOnboarding();
initHelpSheet();
startDashboardPolling();
