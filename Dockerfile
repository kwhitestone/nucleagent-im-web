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

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM ${NGINX_IMAGE} AS final
# One image for every environment: browser endpoints (VITE_* whitelist) and
# frame-ancestors are required at container start, never at build time.

# Outside /etc/nginx/templates: only our validated runtime hook renders it.
COPY nginx.conf.tpl /etc/nginx/runtime.conf.template
COPY docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod 0555 /docker-entrypoint.d/40-runtime-config.sh
COPY --from=web-build /build/dist/ /usr/share/nginx/html/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
