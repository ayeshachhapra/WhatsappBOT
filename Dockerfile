## ---- Build stage ----
FROM node:20-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

COPY frontend/ ./frontend/
RUN cd frontend && npm install && npm run build

## ---- Production stage ----
FROM node:20-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/frontend/dist ./frontend/dist

# Optional: bake credentials into image (anyone with image read access can read these).
# Prefer mounting via secret manager / env vars in production.
# COPY vertex-ai-key.json ./vertex-ai-key.json

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
