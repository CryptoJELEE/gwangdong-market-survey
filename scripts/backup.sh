#!/bin/bash
# 이온로드 데이터 자동 백업 스크립트
# 매일 Railway 서버에서 전체 데이터를 JSON으로 다운로드

BACKUP_DIR="/Users/jerry/Documents/New project/gwangdong-market-survey-webapp/backups"
BASE_URL="https://gwangdong-market-survey-production.up.railway.app"
ADMIN_PASSWORD="${IONROAD_ADMIN_PASSWORD:-ionroad2026}"
DATE=$(date +%Y-%m-%d_%H%M)
FILENAME="ionroad-backup-${DATE}.json"

mkdir -p "$BACKUP_DIR"

# 1. 어드민 로그인하여 토큰 획득
TOKEN=$(curl -s -X POST "$BASE_URL/api/admin/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$ADMIN_PASSWORD\"}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "❌ 백업 실패: 어드민 로그인 실패"
  exit 1
fi

# 2. 토큰으로 백업 데이터 다운로드
HTTP_CODE=$(curl -s -w "%{http_code}" -o "$BACKUP_DIR/$FILENAME" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/backup")

if [ "$HTTP_CODE" -eq 200 ]; then
  COUNT=$(python3 -c "import json; d=json.load(open('$BACKUP_DIR/$FILENAME')); print(d.get('totalSubmissions', len(d.get('submissions',[]))))" 2>/dev/null)
  echo "✅ 백업 완료: $FILENAME ($COUNT건)"
  
  # 백업 파일 영구 보관 (삭제하지 않음)
else
  echo "❌ 백업 실패 (HTTP $HTTP_CODE)"
  rm -f "$BACKUP_DIR/$FILENAME"
  exit 1
fi
