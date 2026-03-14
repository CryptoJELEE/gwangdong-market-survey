# 이온로드 🏃

> 현장 시장조사를 더 쉽고 재밌게

광동제약 현장 시장조사를 위한 스마트폰 최적화 웹앱. 조사원이 매장을 방문해 제품 가격을 기록하고, 관리자가 실시간으로 현황을 파악할 수 있습니다.

## 스크린샷

| 모바일 조사 폼 | 관리자 대시보드 | 지도 클러스터링 |
|:-:|:-:|:-:|
| 3단계 간편 입력 화면 | 통계 차트 + 제출 목록 | 매장 위치 지도 뷰 |

## 주요 기능

- **3단계 간편 기록** (📍 매장 선택 → 💰 가격 입력 → 📸 사진 촬영)
- **GPS 위치 자동 인식** — 현재 위치 기반 매장 추천
- **카카오 주소 검색** — 카카오맵 SDK + REST API 연동
- **제품 리더보드** 🏆 — 조사 진행률 경쟁
- **지도 + 클러스터링** — 조사 완료 매장 시각화
- **뱃지 시스템** — 새싹 → 루키 → 프로 → 챔피언
- **오프라인 지원** — 네트워크 끊겨도 로컬 큐에 저장, 복구 시 자동 전송
- **PWA** — 홈 화면 설치 가능
- **다크모드** — 시스템 설정 연동
- **관리자 대시보드** — 통계/차트/CSV 내보내기/인쇄
- **사진 갤러리** — 매장별 사진 모아보기
- **즐겨찾기 매장** — 자주 가는 매장 빠른 접근
- **실시간 갱신** — 제출 즉시 대시보드 반영
- **제품/지역 동적 관리** — 관리자가 제품·지역 목록을 실시간 수정

## 기술 스택

| 영역 | 기술 |
|------|------|
| 서버 | Node.js (순수 `http` 모듈, 프레임워크 없음) |
| DB | SQLite (`better-sqlite3`, WAL 모드) |
| 프론트엔드 | 바닐라 JavaScript (빌드 도구 없음) |
| 지도/주소 | 카카오맵 SDK + REST API |
| 배포 | Railway (Docker) |

## 빠른 시작

```bash
git clone https://github.com/your-org/gwangdong-market-survey-webapp.git
cd gwangdong-market-survey-webapp
cp .env.example .env   # 카카오 API 키 설정
npm install
npm start              # http://localhost:3000
```

관리자 페이지: `http://localhost:3000/admin`

## 환경변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `PORT` | 서버 포트 | `3000` |
| `KAKAO_REST_API_KEY` | 카카오 REST API 키 | — |
| `ADMIN_PASSWORD` | 관리자 비밀번호 | `ionroad2026` |
| `DB_FILE` | SQLite DB 경로 | `./data/survey.db` |
| `DATA_DIR` | 데이터 디렉토리 | `./data` |
| `UPLOADS_DIR` | 사진 업로드 경로 | `./data/uploads` |

Google Sheets 미러링 등 추가 변수는 `.env.example` 참고.

## 프로젝트 구조

```
src/
├── server.js              # HTTP 서버 + API 라우팅
├── config.js              # 환경변수 로드 + 설정
├── catalog.js             # 제품/지역/매장 카탈로그
├── assignment.js          # 지역 자동 배정 로직
├── geocoding.js           # 카카오 지오코딩 연동
├── utils.js               # 유틸리티 함수
├── storage/
│   ├── index.js           # 스토리지 팩토리
│   ├── sqliteStore.js     # SQLite 저장소 (메인)
│   ├── localStore.js      # JSON 파일 저장소 (레거시)
│   └── googleSheetsStore.js  # Google Sheets 미러링
└── client/
    ├── index.html         # 조사원 메인 페이지
    ├── admin.html         # 관리자 대시보드
    ├── app.js             # 클라이언트 로직
    ├── admin.js           # 관리자 로직
    ├── styles.css         # 스타일시트
    └── manifest.json      # PWA 매니페스트
scripts/
├── lint.js                # 포맷 검사
└── verify.js              # lint + typecheck + test 통합 실행
tests/
├── assignment.test.js     # 배정 로직 테스트
├── geocoding.test.js      # 지오코딩 테스트
└── server.test.js         # API 테스트
```

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/health` | 헬스체크 |
| `GET` | `/api/bootstrap` | 초기 데이터 (제품/지역/매장 목록) |
| `GET` | `/api/survey-stats` | 조사 통계 |
| `GET` | `/api/geocode` | 주소 → 좌표 변환 |
| `GET` | `/api/reverse-geocode` | 좌표 → 주소 변환 |
| `POST` | `/api/submissions` | 조사 제출 |
| `POST` | `/api/submissions/delete` | 제출 삭제 |
| `POST` | `/api/assignments/override` | 배정 수정 |
| `POST` | `/api/admin/login` | 관리자 로그인 |
| `GET` | `/api/admin/verify` | 세션 검증 |
| `GET` | `/api/admin/submissions` | 전체 제출 목록 |
| `GET` | `/api/admin/settings` | 관리자 설정 조회 |
| `POST` | `/api/admin/settings` | 관리자 설정 변경 |
| `GET` | `/api/backup` | DB 백업 다운로드 |

## 스크립트

```bash
npm start        # 서버 실행
npm run dev      # 워치 모드 (자동 재시작)
npm test         # 테스트 실행
npm run lint     # 포맷 검사
npm run verify   # lint + typecheck + test 통합 검증
```

## 배포 (Railway)

1. [Railway](https://railway.app)에서 새 프로젝트 생성
2. GitHub 저장소 연결
3. 환경변수 설정:
   - `KAKAO_REST_API_KEY` — 카카오 개발자 콘솔에서 발급
   - `ADMIN_PASSWORD` — 원하는 관리자 비밀번호
   - `PORT` — Railway가 자동 할당
4. Volume 마운트: `/data` (SQLite DB + 업로드 파일 영속화)
5. 자동 배포 완료 — `railway.toml`과 `Dockerfile` 설정 포함

## 라이선스

MIT
