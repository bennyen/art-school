# Stage 1: build (backend + frontend)
FROM node:24-alpine AS builder

WORKDIR /app

# Server dependencies
COPY package*.json tsconfig.json ./
RUN npm ci

# Frontend dependencies
COPY web/package*.json ./web/
RUN npm ci --prefix web

# Source code
COPY src ./src
COPY web ./web

# Compile the server (tsc) and the frontend (vite)
RUN npm run build

# Stage 2: production
FROM node:24-alpine AS runner

# ffmpeg powers thumbnails, durations and mkv remuxing
RUN apk add --no-cache ffmpeg

WORKDIR /app

ENV NODE_ENV=production
ENV COURSES_PATH=/courses
ENV DATA_PATH=/app/data

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Compiled artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist

EXPOSE 3000

CMD ["node", "dist/index.js"]
