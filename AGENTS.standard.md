# AGENTS.md — 광동 시장조사 웹앱 (표준 프로젝트 컨텍스트)

## Project Overview
광동제약 식음료 사업부 시장조사 데이터를 시각화하는 웹 애플리케이션.
비타500, 옥수수수염차, 삼다수 등 주요 제품군의 시장 현황, 소비자 인식, 경쟁사 분석.

## Setup Commands
- Install deps: `npm install`
- Dev server: `npm run dev`
- Build: `npm run build`

## Tech Stack
- Next.js (App Router, TypeScript)
- Tailwind CSS + shadcn/ui
- Recharts (차트)

## Key Context
- 오너 에이전트: Codex (label: owner-시장조사)
- 광동제약 주요 브랜드: 비타500, 옥수수수염차, 삼다수(유통), 광동상회(D2C)
- 데이터 소스: Embrain 소비자 조사, Nielsen 시장 데이터

## Code Style
- TypeScript strict
- Korean for UI, English for code
- shadcn/ui 컴포넌트 우선

## Security
- 시장조사 데이터는 내부 전용
- 광동제약 임직원 외 접근 불가
