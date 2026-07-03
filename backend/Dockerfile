# Dockerfile — Eather trading bot (botRunner.js)
# ─────────────────────────────────────────────────────────────────────────────
# Builds a runtime image for the NEW trailing-0.05 engine.
# SECURITY: no secrets are copied in (see .dockerignore). The private key, DB URL
# and API keys are provided at RUN time via --env-file / -e, never baked into the
# image layers.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# App source (the .dockerignore keeps .env / ecosystem.config.js OUT of the image)
COPY . .

# Run as the image's built-in non-root user
USER node

# ⚠️ Default entrypoint = the LIVE trading bot (dry-run was removed; BOT_DRY_RUN is
# ignored). docker-compose overrides this with the SIM engine (botSimRunner.js) as
# the safe default — override the command yourself to choose explicitly.
CMD ["node", "botRunner.js"]
