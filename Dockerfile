# One container: the app, the live sync, the MCP and the file writer.
#   docker build -t archnm .
#   docker run -p 5190:5190 -v archnm-data:/data -v "$PWD/architecture:/architecture" \
#     -v "$PWD/tokens.json:/run/archnm/tokens.json:ro" archnm
# (docker-compose.yml is the same thing as a file.)
#
# Base images are pinned by digest (the tag is only for reading). To update one:
#   docker buildx imagetools inspect node:26-slim    # copy the top-level Digest
FROM node:26-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS build
WORKDIR /app
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: the root "prepare" script installs git hooks, and there is no git here.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build && pnpm prune --prod --ignore-scripts

# Litestream, to copy the database to a bucket as it changes (only used when
# ARCHNM_LITESTREAM_URL is set; see docker/start.sh). Pinned by checksum.
FROM debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e AS litestream
ARG TARGETARCH
ARG LITESTREAM=0.5.17
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64; sum=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d ;; \
      arm64) arch=arm64; sum=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5 ;; \
      *) echo "no litestream for $TARGETARCH"; exit 1 ;; \
    esac; \
    f="litestream-$LITESTREAM-linux-$arch.tar.gz"; \
    curl -fsSL -o "/tmp/$f" "https://github.com/benbjohnson/litestream/releases/download/v$LITESTREAM/$f"; \
    echo "$sum  /tmp/$f" | sha256sum -c -; \
    tar -xzf "/tmp/$f" -C /usr/local/bin litestream

FROM node:26-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5
LABEL org.opencontainers.image.title="Archnemesis" \
      org.opencontainers.image.description="Architecture as source, drawn live" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# git for designs that follow a repo; ssh for ssh remotes (mount a key and known_hosts).
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
# Defaults for a container: listen on every interface (so a sign-in that does not trust the
# network is required: tokens here), state under /data, designs under /architecture. Override
# any of them with -e; `archnm config` lists every setting.
ENV NODE_ENV=production \
    ARCHNM_HOST=0.0.0.0 \
    ARCHNM_PORT=5190 \
    ARCHNM_AUTH=tokens \
    ARCHNM_TOKENS=/run/archnm/tokens.json \
    ARCHNM_DB=/data/archnm.sqlite \
    ARCHNM_ROOT=/architecture
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY cli ./cli
COPY schema ./schema
# Sign-in providers you can start from (ARCHNM_AUTH=gcip is the one in examples/auth/gcip).
COPY examples/auth ./examples/auth
COPY docker/start.sh ./docker/start.sh
RUN mkdir -p /data /architecture && chown node:node /data /architecture
USER node
VOLUME ["/data", "/architecture"]
EXPOSE 5190
# /api/config is public (it says how to sign in), so it answers without a token.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.ARCHNM_PORT||5190)+'/api/config').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["sh", "docker/start.sh"]
