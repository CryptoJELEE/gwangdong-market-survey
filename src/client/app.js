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
    if (button.dataset.tab === 'dashboard') initMap();
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
      <div class="field">
        <label>매장 이름</label>
        <input name="storeName" required placeholder="매장 이름을 입력하세요" value="${escapeHtml(savedStoreName)}" />
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
      showToast('GPS 위치를 확인할 수 없어요.', 'error');
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
    if (!e.target.closest('.address-search-wrap')) dropdown.style.display = 'none';
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
    state.currentStep = 3;
    renderCurrentStep(config);
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
      statusEl.textContent = result.error || '저장에 실패했어요.';
      submitBtn.disabled = false;
      return;
    }
    showSuccess(result);
    await loadBootstrap();
  } catch (err) {
    statusEl.textContent = '인터넷 연결을 확인해주세요 📶';
    submitBtn.disabled = false;
  }
}

function showSuccess(result) {
  surveyForm.classList.add('hidden');
  stepIndicator.innerHTML = '';
  successView.classList.remove('hidden');
  successView.innerHTML = `
    <div class="success-card">
      <div class="success-icon">🙌</div>
      <h3>수고했어요!</h3>
      <div class="assigned-area">다음 추천 지역: ${escapeHtml(result.assignment.currentArea)}</div>
      <div class="success-actions">
        <button type="button" class="btn btn-primary" id="new-survey">한 곳 더 갈래요? 🏃</button>
        <button type="button" class="btn btn-secondary" id="view-history">오늘 기록 보기 📋</button>
      </div>
    </div>
  `;
  successView.querySelector('#new-survey').addEventListener('click', () => {
    renderForm(state.bootstrap);
  });
  successView.querySelector('#view-history').addEventListener('click', () => {
    navTabs.forEach((t) => t.classList.toggle('is-active', t.dataset.tab === 'dashboard'));
    panels.forEach((p) => p.classList.toggle('is-active', p.id === 'dashboard'));
    initMap();
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
  document.querySelector('#quick-stats').innerHTML = `
    <div class="quick-stat"><span class="qs-icon">🏃</span><span class="qs-value">${total}</span><span class="qs-label">총 기록</span></div>
    <div class="quick-stat"><span class="qs-icon">📅</span><span class="qs-value">${todayCount}</span><span class="qs-label">오늘</span></div>
    <div class="quick-stat"><span class="qs-icon">👤</span><span class="qs-value">${uniqueResearchers}</span><span class="qs-label">조사자</span></div>
    <div class="quick-stat"><span class="qs-icon">📍</span><span class="qs-value">${coveredAreas}/${areas.length}</span><span class="qs-label">지역</span></div>
  `;

  // 3. Product Leaderboard
  const productStats = calcProductStats(submissions, products);
  const medals = ['🥇', '🥈', '🥉'];
  const leaderboard = document.querySelector('#product-leaderboard');
  leaderboard.innerHTML = `
    <h2>제품 현황판 🏆</h2>
    ${productStats.length === 0 ? '<p class="small">아직 데이터가 없어요.</p>' : productStats.map((ps, i) => {
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
              <strong>${escapeHtml(r.name)}</strong>님이 ${escapeHtml(r.storeName)}에서 ${r.priceCount}개 제품 기록
              <span class="activity-time">${relativeTime(r.createdAt)}</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } else {
    activityEl.innerHTML = '<h2>최근 활동 🕐</h2><p class="small">아직 활동이 없어요.</p>';
  }

  // 6. Submission list with filters
  const filterEl = adminFilter;
  filterEl.innerHTML = `
    <input type="text" id="filter-name" placeholder="이름 검색" />
    <select id="filter-area">
      <option value="">전체 지역</option>
      ${areas.map((a) => `<option value="${a}">${a}</option>`).join('')}
    </select>
  `;
  const filterName = filterEl.querySelector('#filter-name');
  const filterArea = filterEl.querySelector('#filter-area');
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
    : '<div class="notice">아직 기록이 없어요. 첫 번째 기록을 남겨볼까요? 🏃</div>';

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

// ── Init ──
initGps();
loadBootstrap();
