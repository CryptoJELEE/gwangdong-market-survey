# FORJERRY.md — 이온로드 프로젝트 해설서 🏃

> "시장조사 앱을 하나 만들어줘" 한마디에서 시작해서, 하루 반 만에 15라운드 랄프 모드를 거쳐 프로덕션 서비스까지 도달한 이야기.

---

## 🏗️ 아키텍처 — 놀랍도록 단순한 구조

이온로드는 **의존성 하나(better-sqlite3)**로 돌아가는 풀스택 앱입니다.

```
┌─────────────┐     HTTPS      ┌──────────────┐     SQLite      ┌──────────┐
│   📱 모바일   │ ──────────── │  Node.js 서버  │ ──────────── │  /data/   │
│  (바닐라 JS)  │              │  (순수 http)   │              │  survey.db│
└─────────────┘               └──────────────┘               └──────────┘
       │                            │
       │                     ┌──────┴──────┐
       │                     │ 카카오맵 API  │
       │                     │ (주소/지도)   │
       └────────────────────└─────────────┘
```

**왜 이렇게 단순한가?**

React? Vue? Express? PostgreSQL? 전부 고려했지만 다 빼버렸습니다:

1. **사용자가 20명**: 동시 접속 ~20명이면 SQLite WAL 모드로 충분합니다.
2. **앱 설치 불가**: 현장 직원들에게 **링크 하나**로 접속 가능해야 합니다.
3. **배포 단순성**: Railway에 Dockerfile 하나 올리면 끝.

---

## 📁 코드베이스 지도 (7,155줄)

```
src/
├── server.js           ← 833줄 | 웹서버 + 인증 + 웹훅 + 일일리포트
├── config.js           ← 환경변수 + 기본 설정
├── catalog.js          ← 제품/지역/매장유형 기본 목록
├── geocoding.js        ← 카카오 REST API 주소→좌표 변환 + 캐시
├── assignment.js       ← 거리+공정성 기반 조사 지역 자동 배정
├── storage/
│   ├── index.js        ← 스토리지 추상화 (settings 포함)
│   ├── sqliteStore.js  ← SQLite CRUD (WAL, 지오캐시, settings 테이블)
│   └── localStore.js   ← 로컬 JSON 폴백
└── client/
    ├── index.html      ← 203줄 | PWA 셸 + skip-nav + SW 등록
    ├── app.js          ← 2,020줄 | 폼 위저드 + 대시보드 + 갤러리 + 스트릭
    ├── admin.html      ← 255줄 | 관리자 3탭 레이아웃
    ├── admin.js        ← 1,340줄 | 통계/기록/설정 + 히트맵 + 트렌드
    ├── styles.css      ← 1,665줄 | 디자인 시스템 (다크모드/반응형/접근성)
    ├── sw.js           ← 92줄 | Service Worker (오프라인 캐시)
    └── manifest.json   ← PWA 매니페스트
```

---

## 🎯 15라운드에 걸쳐 쌓인 기능 전체 목록

### 📱 사용자 (현장 조사원)
| 기능 | Round | 핵심 |
|------|-------|------|
| 3단계 간편 기록 | MVP | 📍→💰→📸 스텝 위저드 |
| GPS 자동 위치 | MVP | Geolocation API |
| 카카오 주소 검색 | R1 | 2글자+ 입력 시 키워드 드롭다운 |
| 매장명 자동완성 | R4 | 기존 제출 데이터 기반 |
| 멀티 사진 (최대 3장) | R10 | 독립 촬영/삭제, Canvas 압축(1280px, JPEG 0.7) |
| 즐겨찾기 매장 | R8 | 원클릭 자동 채움, 최대 10개 |
| 뱃지 시스템 | R3 | 🌱새싹→🌿성장→🌳나무→💎프로→🏆챔피언 |
| 연속 기록 스트릭 | R11 | 🔥 N일 연속 기록 중! |
| 완료도 점수 | R15 | 0~100점, 🟢🟡🔴 배지 |
| 가격 원화 포맷 | R10 | ₩1,500 시각 포맷 (blur/focus 전환) |
| 가격 단축키 | R13 | Enter→다음 필드, 아코디언 자동 열기 |
| 제출 카운트다운 | R13 | 3초 대기 + 취소 가능 (실수 방지) |
| 중복 매장 감지 | R15 | 같은 날 동일 매장 확인 |
| 오프라인 큐 | R5 | localStorage 저장 → 온라인 시 자동 전송 |
| Service Worker | R12 | Cache-First 정적, Network-First API |
| PWA | R2 | 홈 화면 설치, manifest, 아이콘 |
| 다크모드 | R2 | prefers-color-scheme 자동 감지 |
| 온보딩 | R1 | 3슬라이드 오버레이 |
| FAQ 도움말 | R1 | 하단 시트, 자주 묻는 질문 |
| 공유 | R6 | Web Share API / 클립보드 복사 |
| 컨페티 축하 | R6 | 제출 성공 시 🎊 |
| 진동 피드백 | R9 | navigator.vibrate(200) |

### 📊 대시보드
| 기능 | Round |
|------|-------|
| 카카오맵 + 클러스터링 | MVP+R1 |
| 제품 리더보드 🏆 | MVP |
| 이온킥 vs 경쟁사 가격 비교 | R10 |
| 제품 필터 (전체/자사/경쟁사) | R13 |
| 일일 요약 카드 | R11 |
| 내 기록 섹션 | R3 |
| 사진 갤러리 + 라이트박스 | R8 |
| 30초 자동 새로고침 | R3 |
| 수동 새로고침 버튼 | R9 |
| Quick Stats + 평균 완료도 | R15 |
| 탭 기억 (localStorage) | R13 |

### 🔒 관리자 (/admin)
| 기능 | Round |
|------|-------|
| 비밀번호 로그인 (Bearer 24h) | R1 |
| **3탭 구조** (📊통계/📋기록/⚙️설정) | R13 |
| 일별 추이 차트 | R4 |
| 조사자별 기여도 + **상세 프로필** | R4+R10 |
| 지역별 분포 | R4 |
| 데이터 품질 바 | R4 |
| **매장유형별 제품 보유율** 그룹 차트 | R12 |
| **시간대별 활동 히트맵** (7×24) | R12 |
| **지역별 비교 정렬 테이블** | R12 |
| **제품별 가격 트렌드** + 이상치 | R10 |
| **주간 비교 카드** | R6 |
| CSV 엑스포트 (UTF-8 BOM, GPS) | R1+R6 |
| 인쇄 모드 | R6 |
| 실시간 새 기록 알림 (30초 폴링) | R6 |
| **데이터 가져오기** (JSON 업로드) | R13 |
| **비밀번호 변경** (DB 저장) | R13 |
| **제품/지역/매장유형 동적 관리** | R8 |
| 백업 다운로드 | R1 |
| 요약 인쇄 | R10 |

### 🔧 서버/인프라
| 기능 | Round |
|------|-------|
| Rate limiting (60/분, 제출 10/분, 로그인 5/분) | R5 |
| 입력 검증 (길이/가격/사진 500KB) | R5 |
| ETag + Cache-Control | R5 |
| **웹훅 알림** (새 제출 시 자동 POST) | R14 |
| **일일 요약 HTML** (/api/daily-report, 이메일용) | R14 |
| **일일 요약 API** (/api/daily-summary) | R11 |
| /health (uptime, version) | R14 |
| 매일 23시 자동 백업 (cron) | R1 |
| settings 테이블 (동적 설정) | R8 |

### ♿ 접근성 (R3+R14)
- 키보드 네비게이션 (Escape/화살표/Enter/Space)
- 스크린리더 (skip-nav, aria-live, role=alert/button)
- 고대비 모드 (@prefers-contrast: high)
- 모션 감소 (@prefers-reduced-motion: reduce)
- 터치 타겟 44×44px
- ARIA 탭/패널

### 🎨 CSS 테마 (R2+R11+R15)
- 다크모드 (Tokyo Night)
- 반응형 (320px ~ 1440px+)
- 바 차트 grow 애니메이션
- 카드 ripple + 아코디언 fade+slide
- 뱃지 glow/그라데이션/pulse
- 커스텀 스크롤바
- 한글 가독성 (word-break: keep-all, letter-spacing)

---

## 🐛 버그 전쟁 — 우리가 밟은 지뢰들

### 1. "Missing required submission fields"
3단계 폼 위저드에서 Step 1 데이터를 localStorage에 저장하는 타이밍 문제. → state 객체 + localStorage 이중 백업.

### 2. 카카오맵 "domain mismatched!"
카카오 개발자 콘솔에 `http://`로 등록했는데 Railway는 `https://`. → 정확한 HTTPS 도메인 등록.

### 3. `autoload=false` + `kakao.maps.load()`
카카오 SDK `<script>` 로드 시 타이밍 이슈. → `autoload=false`로 두고 명시적 `kakao.maps.load(callback)` 호출.

### 4. 백업 스크립트 401
어드민 인증 추가 시 자동화 스크립트 미업데이트. → 로그인→토큰→인증 헤더 추가.

### 5. 주소 드롭다운이 아래 항목을 가림
`position: absolute`가 원인. → `position: relative`로 변경, 레이아웃 자연스럽게.

---

## 📊 프로젝트 통계

| 지표 | 값 |
|------|-----|
| 총 코드 | **7,155줄** |
| 커밋 수 | **40개** |
| npm 의존성 | **1개** (better-sqlite3) |
| 테스트 | **17/17** 통과 |
| 랄프 라운드 | **15회** |
| 병렬 에이전트 작업 | **30+개** |
| 개발 기간 | ~24시간 (MVP → 풀 프로덕션) |
| 배포 플랫폼 | Railway (Hobby $5/월) |

---

## 🔮 다음 단계

1. **엑셀(.xlsx) 다운로드** — SheetJS로 직접 엑셀 파일 생성
2. **카카오톡 알림** — 일일 요약을 카카오톡으로 전송
3. **커스텀 도메인** — ionroad.kwangdong.co.kr
4. **사용자 피드백 수집** → 실사용 데이터 기반 추가 개선
5. **Google Sheets 연동** — 실시간 스프레드시트 미러

---

*이 문서는 Jarvis (AI 아키텍트)가 작성했습니다. 2026-03-15, Round 15까지의 전체 여정을 담았습니다.*
