# --- Stage 1: build the React dashboard -------------------------------------
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Clerk publishable key is baked in at build time (Vite). Optional — without it
# the app falls back to the lightweight username login.
ARG VITE_CLERK_PUBLISHABLE_KEY=""
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
RUN npm run build

# --- Stage 2: python runtime that serves the API + built dashboard ----------
FROM python:3.12-slim AS runtime
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY firewall/ ./firewall/
COPY api/ ./api/
# api/main.py mounts ../frontend/dist at "/" when it exists.
COPY --from=frontend /app/frontend/dist ./frontend/dist

EXPOSE 8000
# Host provides $PORT (Render sets it); default to 8000 locally.
CMD ["sh", "-c", "uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
