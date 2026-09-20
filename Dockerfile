# syntax=docker/dockerfile:1
#
# Self-contained build; the context is this repository's root.
#
#   docker build -t nucleagent-im-web .
#
ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine

FROM ${NODE_IMAGE} AS web-build
WORKDIR /build

# Vite inlines these values at build time.
ARG VITE_AUTH_BASE=https://nucleagent-auth.dev.ndaeweb.com
ARG VITE_IM_BASE=https://nucleagent-im.dev.ndaeweb.com

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN VITE_AUTH_BASE="${VITE_AUTH_BASE}" \
    VITE_IM_BASE="${VITE_IM_BASE}" \
    npm run build

FROM ${NGINX_IMAGE} AS final

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /build/dist/ /usr/share/nginx/html/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
