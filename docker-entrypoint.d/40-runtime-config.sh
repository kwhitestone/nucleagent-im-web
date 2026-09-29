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

export FRAME_ANCESTORS

# Substitute only our own placeholder; nginx's own variables must survive.
envsubst '${FRAME_ANCESTORS}' \
    < /etc/nginx/templates/nginx.conf.tpl \
    > /etc/nginx/conf.d/default.conf
