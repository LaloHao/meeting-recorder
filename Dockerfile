# meeting-recorder: the agent with Google Chrome, a virtual display (Xvfb) and ffmpeg.
# amd64 only: Google Chrome has no Linux arm64 build.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      google-chrome-stable xvfb ffmpeg tar \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
 && apt-get purge -y curl gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY shared ./shared

# Unprivileged; HOME and the recordings live in writable volumes so the root file
# system can be read-only.
RUN useradd --uid 10001 --create-home --home-dir /home/recorder recorder \
 && mkdir -p /recordings && chown recorder /recordings
USER 10001
# Chrome's sandbox needs user namespaces, which a container's default seccomp profile
# denies; the browser only opens the meeting, runs unprivileged and holds no cluster
# credentials (see docs/kubernetes.md).
ENV MEETING_RECORDER_CHROME_FLAGS=--no-sandbox \
    HOME=/home/recorder \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    MEETING_RECORDER_PROFILES=/home/recorder/profiles \
    MEETING_RECORDER_OUT=/recordings \
    NODE_ENV=production

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
