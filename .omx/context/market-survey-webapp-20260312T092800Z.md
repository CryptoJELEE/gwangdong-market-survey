# Market Survey Webapp Context Snapshot

## Task statement
Build a new smartphone-first web app for Kwangdong Pharm distribution market survey operations.

## Desired outcome
Deliver an MVP that field researchers can use on mobile phones to submit store surveys with photos and product prices, while admins can manage area assignments and review submissions/history.

## Confirmed requirements
- New greenfield project
- Mobile-first web app
- Three MVP pillars:
  1. automatic area assignment
  2. market survey input / collection
  3. historical data management
- Auto-assignment priority: residence proximity first, fairness second
- First storage target: Google Sheets
- Field convenience matters: photo capture, mobile input minimization
- Sample data shape includes:
  - region
  - account / store type
  - store name
  - POS count
  - display location
  - product-size-specific prices

## Constraints
- User asked to stop interviewing and proceed automatically
- User explicitly asked to form a team and develop through discussion/execution
- Prefer no new dependencies unless truly necessary
- Must verify with runnable local checks

## Practical assumptions for MVP
- Use a lightweight Node + browser stack that can run locally without external build tooling
- Support local dev/demo mode when Google credentials are absent, while preserving Google Sheets integration path
- Treat photo upload as image attachment stored by the app with metadata linked to submissions
- Include a simple admin override for assignment results

## Likely touchpoints
- package.json
- src/server/*
- src/client/*
- src/shared/*
- data/* or storage/* for local dev fallback
- tests/*
- README.md
- .env.example
