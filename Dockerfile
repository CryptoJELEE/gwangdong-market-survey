FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data/uploads

ENV DATA_DIR=/data
ENV DB_FILE=/data/survey.db
ENV UPLOADS_DIR=/data/uploads
ENV NODE_ENV=production

EXPOSE ${PORT:-3000}

CMD ["node", "src/server.js"]
