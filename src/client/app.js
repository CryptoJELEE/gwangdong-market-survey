const state = {
  bootstrap: null,
  mapInitialized: false,
  kakaoMap: null
};

const surveyForm = document.querySelector('#survey-form');
const submissionList = document.querySelector('#submission-list');
const adminSummary = document.querySelector('#admin-summary');
const tabs = [...document.querySelectorAll('.tab')];
const panels = [...document.querySelectorAll('.panel')];

tabs.forEach((button) => {
  button.addEventListener('click', () => {
    tabs.forEach((item) => item.classList.toggle('is-active', item === button));
    panels.forEach((panel) => panel.classList.toggle('is-active', panel.id === button.dataset.tab));
    if (button.dataset.tab === 'map') {
      initMap();
    }
  });
});

function priceFieldName(productId, size) {
  return `${productId}__${size}`;
}

function renderForm(bootstrap) {
  surveyForm.innerHTML = '';
  surveyForm.innerHTML = `
    <div>
      <h2>시장조사 등록</h2>
      <p class="hint">스마트폰에서 빠르게 조사 내용을 입력하세요. 저장하면 담당 지역이 자동 배정됩니다.</p>
    </div>
    <div class="grid two">
      <div class="field"><label>조사자 이름<input name="researcherName" required /></label></div>
      <div class="field"><label>거주 지역<select name="residenceArea">${bootstrap.areas.map((area) => `<option value="${area}">${area}</option>`).join('')}</select></label></div>
    </div>
    <div class="grid two">
      <div class="field"><label>조사 지역<input name="region" required placeholder="예: 강남" /></label></div>
      <div class="field"><label>거래처 / 조사유형<select name="storeType">${bootstrap.storeTypeTemplates.map((item) => `<option value="${item.label}">${item.label}</option>`).join('')}</select></label></div>
    </div>
    <div class="template-chips">${bootstrap.storeTypeTemplates.map((item) => `<button type="button" class="chip" data-store-template="${item.id}">${item.label}</button>`).join('')}</div>
    <div class="grid two">
      <div class="field"><label>점포명<input name="storeName" required /></label></div>
      <div class="field"><label>POS 대수<input name="posCount" type="number" min="0" value="1" /></label></div>
    </div>
    <div class="field"><label>진열 위치<input name="displayLocation" placeholder="예: 계산대 앞 / 냉장고 / 매대" /></label></div>
    <div class="field"><label>점포 사진<input name="photo" type="file" accept="image/*" capture="environment" /></label></div>
    <div class="field"><label>메모<textarea name="notes" rows="3" placeholder="프로모션, 품절, 경쟁사 특이사항 등을 적어주세요"></textarea></label></div>
    <div class="stack">
      <div>
        <h3>제품별 가격 입력</h3>
        <p class="small">판매하지 않는 제품은 비워두고, 최소 1개 이상의 가격을 입력해주세요.</p>
      </div>
      <div class="matrix">
        ${bootstrap.products.map((product) => `
          <div class="matrix-row stack">
            <strong>${product.label}</strong>
            <span class="small">${product.brand}</span>
            ${product.sizes.map((size) => `<label class="field"><span>${size}</span><input inputmode="numeric" name="${priceFieldName(product.id, size)}" placeholder="₩" /></label>`).join('')}
          </div>
        `).join('')}
      </div>
    </div>
    <div class="actions">
      <button type="submit" class="tab is-active">조사 저장</button>
      <span id="submit-status" class="small"></span>
    </div>
  `;

  const storeTypeField = surveyForm.querySelector('[name="storeType"]');
  const posCountField = surveyForm.querySelector('[name="posCount"]');
  surveyForm.querySelectorAll('[data-store-template]').forEach((button) => {
    button.addEventListener('click', () => {
      const template = bootstrap.storeTypeTemplates.find((item) => item.id === button.dataset.storeTemplate);
      if (!template) return;
      storeTypeField.value = template.label;
      posCountField.value = template.defaultPosCount;
    });
  });

  surveyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = surveyForm.querySelector('#submit-status');
    status.textContent = '저장 중...';
    const formData = new FormData(surveyForm);
    const photoFile = formData.get('photo');
    const photoDataUrl = photoFile && photoFile.size ? await fileToDataUrl(photoFile) : '';
    const prices = [];
    for (const product of bootstrap.products) {
      for (const size of product.sizes) {
        const name = priceFieldName(product.id, size);
        const price = formData.get(name);
        if (price) {
          prices.push({ productId: product.id, productLabel: product.label, size, price });
        }
      }
    }

    const payload = {
      researcher: {
        name: formData.get('researcherName'),
        residenceArea: formData.get('residenceArea')
      },
      survey: {
        region: formData.get('region'),
        storeType: formData.get('storeType'),
        storeName: formData.get('storeName'),
        posCount: formData.get('posCount'),
        displayLocation: formData.get('displayLocation')
      },
      notes: formData.get('notes'),
      photoDataUrl,
      prices
    };

    const response = await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) {
      status.textContent = result.error || '저장에 실패했습니다.';
      return;
    }
    status.textContent = `저장되었습니다. 배정 지역: ${result.assignment.currentArea}`;
    surveyForm.reset();
    await bootstrap();
  });
}

function renderAdmin(bootstrap) {
  const counts = bootstrap.submissions.reduce((acc, submission) => {
    const key = submission.assignment.currentArea;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  adminSummary.innerHTML = bootstrap.areas.map((area) => `
    <div class="summary-tile">
      <span class="small">${area}</span>
      <strong>${counts[area] || 0}</strong>
    </div>
  `).join('');

  submissionList.innerHTML = bootstrap.submissions.length
    ? bootstrap.submissions.map((submission) => `
      <article class="submission-card stack">
        <div class="actions">
          <strong>${submission.survey.storeName}</strong>
          <span class="small">${new Date(submission.createdAt).toLocaleString()}</span>
        </div>
        <div class="small">${submission.researcher.name} · ${submission.researcher.residenceArea} → <strong>${submission.assignment.currentArea}</strong></div>
        <div class="small">${submission.survey.region} · ${submission.survey.storeType} · POS ${submission.survey.posCount}</div>
        <div class="small">Prices: ${submission.prices.map((price) => `${price.productLabel} ${price.size} ₩${price.price}`).join(', ')}</div>
        ${submission.photo ? `<img class="photo-preview" src="${submission.photo.url}" alt="${submission.survey.storeName}" />` : ''}
        <div class="actions">
          <select data-submission-id="${submission.id}">${bootstrap.areas.map((area) => `<option value="${area}" ${area === submission.assignment.currentArea ? 'selected' : ''}>${area}</option>`).join('')}</select>
          <button data-action="override" data-submission-id="${submission.id}">지역 변경</button>
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
        await bootstrap();
      }
    });
  });
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

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
    const lat = sub.lat || (sub.geocode && sub.geocode.lat);
    const lng = sub.lng || (sub.geocode && sub.geocode.lng);
    if (!lat || !lng) return;

    const color = getResearcherColor(sub.researcher.name);
    const position = new kakao.maps.LatLng(lat, lng);
    bounds.extend(position);
    hasMarkers = true;

    const marker = new kakao.maps.Marker({
      map,
      position,
      image: createMarkerImage(color)
    });

    const priceCount = sub.prices ? sub.prices.length : 0;
    const date = new Date(sub.createdAt).toLocaleDateString('ko-KR');
    const content = `<div style="padding:8px 12px;font-size:13px;line-height:1.6;max-width:220px;">
      <strong>${sub.survey.storeName}</strong><br/>
      ${sub.researcher.name} · ${date}<br/>
      ${sub.survey.storeType} · 가격 ${priceCount}건
    </div>`;

    const infoWindow = new kakao.maps.InfoWindow({ content });
    kakao.maps.event.addListener(marker, 'click', () => {
      if (openInfoWindow.current) openInfoWindow.current.close();
      infoWindow.open(map, marker);
      openInfoWindow.current = infoWindow;
    });
  });

  if (hasMarkers) {
    map.setBounds(bounds);
  }

  // Render legend
  const legend = document.getElementById('map-legend');
  legend.innerHTML = Object.entries(researcherColorMap).map(([name, color]) =>
    `<div class="legend-item"><span class="legend-dot" style="background:${color}"></span>${name}</div>`
  ).join('');

  // Render coverage stats
  const coverageStats = document.getElementById('coverage-stats');
  if (statsData.areas && statsData.areas.length) {
    coverageStats.innerHTML = statsData.areas.map((a, i) => {
      const bg = MARKER_COLORS[i % MARKER_COLORS.length];
      return `<div class="summary-tile"><span class="coverage-badge" style="background:${bg}">${a.area}</span><strong>${a.count}건</strong></div>`;
    }).join('');
  }
}

async function bootstrap() {
  const response = await fetch('/api/bootstrap');
  state.bootstrap = await response.json();
  renderForm(state.bootstrap);
  renderAdmin(state.bootstrap);
}

bootstrap();
