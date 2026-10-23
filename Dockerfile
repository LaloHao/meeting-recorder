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
# Chrome is pinned: a session only works in the Chrome version that signed it in (a newer
# one can drop its cookies), so changing it means signing the accounts in again with the
# new image (docs/kubernetes.md). Version and SHA256 from
# https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages
ARG CHROME_VERSION=156.0.8078.47-1
ARG CHROME_SHA256=6c92cd22e90c6e3e255d782991543fa2091db8614e8536a971a7433a5c4d7ac8
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSLo /tmp/chrome.deb "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb" \
 && echo "${CHROME_SHA256}  /tmp/chrome.deb" | sha256sum -c - \
 && apt-get install -y --no-install-recommends \
      /tmp/chrome.deb xvfb ffmpeg tar \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
 && rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome* \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
# The session lives in the web cookies only. With browser sign-in, signing in to Google
# also signs Chrome in and keeps a token outside the session files that are moved around;
# a Chrome that finds the account without its token drops the Google cookies.
RUN mkdir -p /etc/opt/chrome/policies/managed \
 && echo '{"BrowserSignin": 0, "SyncDisabled": true}' > /etc/opt/chrome/policies/managed/meeting-recorder.json

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
