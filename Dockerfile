# --- Stage 1: build the React dashboard -------------------------------------
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Frontend build-time config (Vite bakes VITE_* at build). Google sign-in is the
# default; Clerk is opt-in (needs VITE_USE_CLERK=true as well) and off by default.
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
ARG VITE_USE_CLERK=""
ENV VITE_USE_CLERK=$VITE_USE_CLERK
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
