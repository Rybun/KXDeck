FROM node:20-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=frontend-builder /app/frontend/dist ./static

# Commit corto de git del build (pasado por CI, ver
# .github/workflows/docker-publish.yml) -- se ensena en la tarjeta "Acerca
# de KXDeck" del panel (ver backend/kx_home.py). "dev" si no se pasa (p.ej.
# build local con docker compose).
ARG KXDECK_VERSION=dev
ENV KXDECK_VERSION=${KXDECK_VERSION}

EXPOSE 5000
CMD ["python", "app.py"]
