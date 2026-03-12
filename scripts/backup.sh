#!/bin/bash
# 이온로드 데이터 자동 백업 스크립트
# 매일 Railway 서버에서 전체 데이터를 JSON으로 다운로드

BACKUP_DIR="/Users/jerry/Documents/New project/gwangdong-market-survey-webapp/backups"
API_URL="https://gwangdong-market-survey-production.up.railway.app/api/backup"
DATE=$(date +%Y-%m-%d_%H%M)
FILENAME="ionroad-backup-${DATE}.json"

mkdir -p "$BACKUP_DIR"

# 다운로드
HTTP_CODE=$(curl -s -w "%{http_code}" -o "$BACKUP_DIR/$FILENAME" "$API_URL")

if [ "$HTTP_CODE" -eq 200 ]; then
  COUNT=$(python3 -c "import json; d=json.load(open('$BACKUP_DIR/$FILENAME')); print(d['totalSubmissions'])" 2>/dev/null)
  echo "✅ 백업 완료: $FILENAME ($COUNT건)"
  
  # 30일 이상 된 백업 삭제 (보관 주기)
  find "$BACKUP_DIR" -name "ionroad-backup-*.json" -mtime +30 -delete 2>/dev/null
else
  echo "❌ 백업 실패 (HTTP $HTTP_CODE)"
  rm -f "$BACKUP_DIR/$FILENAME"
  exit 1
fi
