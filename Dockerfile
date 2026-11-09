# claude-code-runner: an HTTP API that runs Claude Code (Agent SDK) in project folders.
# Runs as "node" (uid 1000). Docker access comes from the host socket plus
# group_add (see compose.yaml); there is no init system and no root at runtime.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Tools Claude Code reaches for while working on projects.
# build-essential + python3: native npm modules (better-sqlite3, ...) and scripts.
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl wget git gnupg openssh-client jq ripgrep less procps unzip zip \
        python3 python3-venv python3-pip build-essential && \
    rm -rf /var/lib/apt/lists/*

# Docker CLI + compose plugin (client only, talks to the mounted host socket) and GitHub CLI.
# The gh keyring is checked against GitHub's published key fingerprints.
# git uses gh for https://github.com credentials, so `gh auth login` (or GH_TOKEN) is enough for push.
RUN install -d -m 0755 /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    gpg --batch --show-keys --with-colons /etc/apt/keyrings/githubcli-archive-keyring.gpg | \
        awk -F: '/^pub:/ { want=1; next } want && /^fpr:/ { want=0; n++; \
            if ($10 != "2C6106201985B60E6C7AC87323F3D4EA75716059" && \
                $10 != "7F38BBB59D064DBCB3D84D725612B36462313325") bad=1 } \
            END { exit (bad || n == 0) }' && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update -y && \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin gh && \
    git config --system credential.https://github.com.helper "" && \
    git config --system --add credential.https://github.com.helper "!/usr/bin/gh auth git-credential" && \
    docker --version && docker compose version && gh --version && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# The SDK ships the Claude Code binary for this platform as an optional dependency.
# Linking it as `claude` gives a CLI (for `claude /login`, `claude setup-token`)
# that is always the same version the SDK drives.
RUN npm ci --omit=dev && npm cache clean --force && \
    ln -s "$(ls -d /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude | head -n1)" /usr/local/bin/claude && \
    claude --version
COPY src ./src

USER node
ENV HOME=/home/node \
    NODE_ENV=production \
    PORT=3000 \
    WORKSPACE_ROOT=/opt/workspace \
    DATA_DIR=/home/node/.claude-code-runner
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.ts"]
