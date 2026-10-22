# Running meeting-recorder in Kubernetes

Ask the cluster, from your laptop, to send the agent to a meeting; the recording lands
in S3-compatible storage (or a volume). Each meeting is a **Job**, created on demand by
the CLI with your kubeconfig: nothing runs while there are no meetings, and nothing is
exposed to the internet.

```
laptop                                   cluster (namespace meeting-recorder)
──────                                   ────────────────────────────────────
meeting-recorder k8s join <url> ───────▶ Job ─▶ Pod: Chrome (Xvfb) records the meeting
  reads ConfigMap meeting-recorder-settings      │ profile from PVC meeting-recorder-profile-<account>
                                                 └▶ uploads <name>.webm + <name>.json to s3://…
```

## What you need

- A cluster with **amd64** nodes (Google Chrome has no Linux arm64 build) and a default
  StorageClass (for the account profiles).
- `kubectl` and `helm` on your laptop, and this CLI (`pnpm build`).
- For S3 storage: a bucket and an access key limited to it. Cloudflare R2 works.
- A Google account for the agent, signed in to a local profile (`meeting-recorder login -p
  <account>`). A dedicated account is best: the agent appears under its name.

## Install

```bash
kubectl create namespace meeting-recorder
# The recording Pods meet the "restricted" Pod Security Standard.
kubectl label namespace meeting-recorder pod-security.kubernetes.io/enforce=restricted

# S3 credentials (never stored in the chart or in git)
kubectl -n meeting-recorder create secret generic meeting-recorder-s3 \
  --from-literal=AWS_ACCESS_KEY_ID=… --from-literal=AWS_SECRET_ACCESS_KEY=…

helm install meeting-recorder deploy/helm/meeting-recorder -n meeting-recorder \
  --set storage.s3.url=s3://my-meeting-recordings \
  --set storage.s3.endpoint=https://<account-id>.r2.cloudflarestorage.com \
  --set timeZone=America/Mexico_City
```

The chart only publishes the settings (`ConfigMap meeting-recorder-settings`: image,
resources, storage, defaults) and a `ResourceQuota` (`maxConcurrent`, default 2). See
[values.yaml](../deploy/helm/meeting-recorder/values.yaml); `storage.type=pvc` keeps
recordings on a volume instead of uploading them.

## Move the account's session into the cluster

```bash
meeting-recorder login -p bot                 # once, on your laptop
meeting-recorder k8s seed-profile -p bot      # into PVC meeting-recorder-profile-bot
```

`seed-profile` exports the profile's session (its cookies and two small settings files),
copies it into the account's PVC through a short-lived Pod, and then offers to delete the
local profile.

**A session must live in one place only.** Google keeps rotating some of its session
cookies; when one copy of a session presents cookies another copy already rotated, Google
treats them as stolen and ends the session. That is why:

- the profile is a **volume the Jobs write to**, so rotated cookies are kept for the next
  recording, rather than a read-only Secret;
- the CLI runs **one recording per account at a time**;
- the session is **moved**, not copied.

When Google ends the session anyway, the agent stops with "Google no longer accepts the
session": sign in again and `seed-profile` again.

## Record

```bash
meeting-recorder k8s join https://meet.google.com/abc-defg-hij -p bot -l es -t "Daily"
meeting-recorder k8s list
meeting-recorder k8s logs meeting-recorder-x7k2p -f
meeting-recorder k8s stop meeting-recorder-x7k2p     # saves and uploads what was recorded
```

Let the agent in from the meeting when it asks to join. It leaves when the call ends, after
being alone for `--alone` minutes, or at `--max`. The files go to
`s3://bucket/prefix/<year>/<month>/`; the `.json` is uploaded last, so its presence means
the video is complete. Analyse them with
[video-context](https://github.com/LaloHao/video-context).

## The Job

- **One Pod, no retries** (`backoffLimit: 0`): a retry would ask to join the meeting again.
  `activeDeadlineSeconds` is `--max` plus 10 minutes, and finished Jobs stay one day.
- **Stopping saves:** deleting the Job sends SIGTERM; the agent stops recording, finishes the
  video and uploads it (`terminationGracePeriodSeconds: 300`).
- **Unprivileged:** runs as user 10001, read-only root file system, no capabilities,
  seccomp `RuntimeDefault`, no service account token. Volumes: the profile PVC, `/dev/shm`
  in memory (1 GiB; Chrome needs more than the default 64 MiB), `/tmp` and `/recordings`.
- **Chrome runs with `--no-sandbox`:** its sandbox needs user namespaces, which the default
  seccomp profile of a container denies. The browser only opens the meeting and holds no
  cluster credentials.
- **Resources:** about one core per recording (Chrome, Meet and software VP9 at 15 fps);
  requests 1 CPU / 1.5 GiB, limits 2 CPU / 3 GiB by default.

## Updating

The image is `ghcr.io/lalohao/meeting-recorder`, tagged `latest` and with the short commit
of each build of `main`. Pin a tag with `--set image.tag=<sha>` (or in your GitOps values)
and change it to update; Jobs created afterwards use the new image.
