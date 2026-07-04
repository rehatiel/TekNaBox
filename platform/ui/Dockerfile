# ── Stage 1: Build React app ──────────────────────────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# VITE_WS_BASE:  WebSocket URL of the API (e.g. wss://tekn-api.example.com)
#                Used by terminal.html and bandwidth.html popups.
# VITE_API_BASE: HTTPS URL of the API (e.g. https://tekn-api.example.com)
#                Used as fallback for enrollment URLs if the server-side bootstrap_url is unavailable.
ARG VITE_WS_BASE
ARG VITE_API_BASE
ENV VITE_WS_BASE=$VITE_WS_BASE
ENV VITE_API_BASE=$VITE_API_BASE

RUN npm run build

# ── Stage 2: Serve with nginx ─────────────────────────────────────────────────
FROM nginx:alpine@sha256:54f2a904c251d5a34adf545a72d32515a15e08418dae0266e23be2e18c66fefa

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Copy our nginx config
COPY docker/nginx.conf /etc/nginx/conf.d/msp.conf

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
