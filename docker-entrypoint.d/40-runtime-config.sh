#!/bin/sh
set -eu

# These values are operator input (build/deploy configuration), never request
# parameters. Validate them before interpolating into the nginx config so a
# malformed value fails the container start instead of silently producing a
# broken — or injected — server block.
valid_origin() {
    # grep matches per line; reject control characters and newlines up front.
    case "$1" in *[![:alnum:].:/-]*) return 1 ;; esac
    printf '%s\n' "$1" | grep -Eq '^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$' || return 1
    authority=${1#*://}
    case "$authority" in
        *:*) port=${authority##*:}; [ "$port" -ge 1 ] && [ "$port" -le 65535 ] ;;
        *) return 0 ;;
    esac
}

# The frame-ancestors default follows the shell the browser trusts.
SHELL_ORIGIN=${SHELL_ORIGIN:-${VITE_SHELL_URL:-}}

for var in SHELL_ORIGIN; do
    eval "value=\${$var:-}"
    if ! valid_origin "$value"; then
        printf '%s must be a single HTTP(S) origin (scheme://host[:port]) with no path, query or credentials.\n' "$var" >&2
        exit 1
    fi
done

# An unset list preserves the single-shell contract; an explicit empty list
# is a configuration error. Parse commas without shell word splitting.
remaining=${FRAME_ANCESTORS-$SHELL_ORIGIN}
FRAME_ANCESTORS=
while :; do
    origin=${remaining%%,*}
    if ! valid_origin "$origin"; then
        printf '%s\n' 'FRAME_ANCESTORS must be a comma-separated list of exact HTTP(S) origins.' >&2
        exit 1
    fi
    FRAME_ANCESTORS="${FRAME_ANCESTORS:+$FRAME_ANCESTORS }$origin"
    case "$remaining" in
        *,*) remaining=${remaining#*,} ;;
        *) break ;;
    esac
done

# Browser endpoints (public, non-secret). Only these keys are serialized; the
# environment is never enumerated. Validation restricts every value to
# [A-Za-z0-9.:/_-], so no JSON escaping is needed. Missing values fail closed.
runtime_keys='VITE_AUTH_BASE VITE_IM_BASE VITE_CORE_BASE VITE_SHELL_URL VITE_SHELL_ALLOWED_ORIGINS VITE_ACCOUNT_UI_URL'
json='{'
separator=
for var in $runtime_keys; do
    eval "value=\${$var-}"
    eval "present=\${$var+x}"
    case "$var" in
        VITE_SHELL_ALLOWED_ORIGINS)
            # Optional; empty keeps VITE_SHELL_URL as the single trusted shell.
            remaining=$value
            while [ -n "$remaining" ]; do
                item=${remaining%%,*}
                if ! valid_origin "$item"; then
                    printf '%s contains an invalid origin.\n' "$var" >&2
                    exit 1
                fi
                case "$remaining" in
                    *,) printf '%s contains an empty origin.\n' "$var" >&2; exit 1 ;;
                    *,*) remaining=${remaining#*,} ;;
                    *) break ;;
                esac
            done ;;
        VITE_ACCOUNT_UI_URL)
            # Required; explicitly empty selects the minimal identity card.
            if [ "$present" != x ]; then
                printf '%s must be explicitly configured (empty disables the account popover).\n' "$var" >&2
                exit 1
            fi
            if [ -n "$value" ]; then
                case "$value" in *[![:alnum:]._:/-]*) bad=1 ;; *) bad= ;; esac
                authority=${value#*://}
                origin_part=${value%%://*}://${authority%%/*}
                case "$authority" in */*) ;; *) bad=1 ;; esac
                if [ -n "$bad" ] || ! valid_origin "$origin_part"; then
                    printf '%s must be an HTTP(S) URL with a plain path and no query, fragment or credentials.\n' "$var" >&2
                    exit 1
                fi
            fi ;;
        *)
            if ! valid_origin "$value"; then
                printf '%s must be a single HTTP(S) origin.\n' "$var" >&2
                exit 1
            fi ;;
    esac
    json="$json$separator\"$var\":\"$value\""
    separator=,
done
mkdir -p /etc/nucleagent
printf '%s}\n' "$json" > /etc/nucleagent/runtime-config.json
chmod 0644 /etc/nucleagent/runtime-config.json

export FRAME_ANCESTORS

# Substitute only our own placeholder; nginx's own variables must survive.
envsubst '${FRAME_ANCESTORS}' \
    < /etc/nginx/runtime.conf.template \
    > /etc/nginx/conf.d/default.conf
