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
ARG VITE_AUTH_BASE
ARG VITE_IM_BASE
# The nucleagent-web shell origin. Embedded mode accepts session pushes from
# this exact origin only (src/shell.ts), and nginx allows framing only from it.
ARG VITE_SHELL_URL
# The shell-owned AccountPopover remote module (UNI-ACCTUI), imported at
# runtime; a shell deploy updates it with no im-web rebuild. Empty: the
# identity card shows avatar + name only.
ARG VITE_ACCOUNT_UI_URL

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN test -n "${VITE_AUTH_BASE}" && test -n "${VITE_IM_BASE}" && test -n "${VITE_SHELL_URL}" && \
    VITE_AUTH_BASE="${VITE_AUTH_BASE}" \
    VITE_IM_BASE="${VITE_IM_BASE}" \
    VITE_SHELL_URL="${VITE_SHELL_URL}" \
    VITE_ACCOUNT_UI_URL="${VITE_ACCOUNT_UI_URL}" \
    npm run build

FROM ${NGINX_IMAGE} AS final
ARG VITE_SHELL_URL

# frame-ancestors is resolved at container start by nginx's own envsubst of
# /etc/nginx/templates. Changing the shell origin also requires rebuilding the
# baked Vite origin above. Mirrors nucleagent-core-web's Dockerfile.
ENV SHELL_ORIGIN=${VITE_SHELL_URL}

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web-build /build/dist/ /usr/share/nginx/html/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
