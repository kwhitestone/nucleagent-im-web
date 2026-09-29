server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;
    server_tokens off;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }

    # Portal SSO callback. The portal appends the one-shot credential as a query
    # parameter, so this route must never reach the access log, and must send
    # Referrer-Policy: no-referrer per nucleagent-auth/docs/portal-sso.md.
    # A location that calls add_header does not inherit the server-level ones,
    # so the shared headers are repeated here.
    location = /auth/portal {
        access_log off;
        try_files /index.html =404;
        add_header X-Content-Type-Options nosniff always;
        add_header Cache-Control "no-store" always;
        add_header Referrer-Policy no-referrer always;
        # Unlike the rest of the app, the standalone callback page is never
        # framed — the shell owns its own callback on its own origin.
        add_header Content-Security-Policy "frame-ancestors 'none'" always;
        add_header X-Frame-Options DENY always;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    add_header X-Content-Type-Options nosniff always;
    add_header Cache-Control "no-cache" always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    # im-web is a remote application of the nucleagent-web shell, so it must be
    # framable by that origin and nothing else. FRAME_ANCESTORS is substituted
    # by the dedicated runtime script at container start.
    add_header Content-Security-Policy "frame-ancestors ${FRAME_ANCESTORS}" always;
}
