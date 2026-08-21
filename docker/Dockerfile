FROM alpine:edge

ARG RQLITE_VERSION=10.2.7

RUN apk update && \
      apk --no-cache upgrade
RUN apk add --no-cache \
      apache2-utils \
      ca-certificates \
      gettext \
      libsodium-dev \
      lua-resty-http \
      openresty \
      su-exec \
      wget && \
    wget -q \
      "https://github.com/rqlite/rqlite/releases/download/v${RQLITE_VERSION}/rqlite-v${RQLITE_VERSION}-linux-amd64-musl.tar.gz" \
      -O /tmp/rqlite.tar.gz && \
    tar -xzf /tmp/rqlite.tar.gz -C /tmp && \
    mv \
      "/tmp/rqlite-v${RQLITE_VERSION}-linux-amd64-musl/rqlited" \
      "/tmp/rqlite-v${RQLITE_VERSION}-linux-amd64-musl/rqlite" \
      /usr/local/bin/ && \
    rm -rf /tmp/rqlite.tar.gz "/tmp/rqlite-v${RQLITE_VERSION}-linux-amd64-musl" && \
    addgroup -g 1000 rqlite && \
    adduser -D -u 1000 -G rqlite rqlite

WORKDIR /opt/txt

COPY entrypoint.sh /opt/txt/entrypoint.sh
COPY nginx.conf /opt/txt/nginx.conf
COPY lua /opt/txt/lua
COPY migrations /opt/txt/migrations

RUN chmod 0755 /opt/txt/entrypoint.sh

EXPOSE 8080 4002

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:14001/readyz || exit 1

ENTRYPOINT ["/opt/txt/entrypoint.sh"]
