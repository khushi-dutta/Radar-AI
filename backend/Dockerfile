FROM node:22-slim

# better-sqlite3 ships prebuilt binaries for common platforms, but falls back to
# a source build when none matches. These are the toolchain for that fallback.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so `npm ci` is cached independently of source changes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

# The SQLite file lives on a volume so it survives container replacement.
ENV DATA_DIR=/data
ENV DB_PATH=/data/pulse.db
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
