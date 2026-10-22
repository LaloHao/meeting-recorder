// The Kubernetes Job of one recording, built from the settings the Helm chart
// publishes (ConfigMap `meeting-recorder-settings`) and the request from the CLI.
// See docs/kubernetes.md.

export const APP_LABEL = 'app.kubernetes.io/name'
export const APP = 'meeting-recorder'
export const PROFILE_LABEL = 'meeting-recorder/profile'
export const SETTINGS_CONFIGMAP = 'meeting-recorder-settings'

/** What the chart publishes (as JSON in the ConfigMap's `settings.json`). */
export interface ClusterSettings {
  image: string
  imagePullSecret?: string
  /** Time zone for the file names (e.g. America/Mexico_City). */
  timeZone?: string
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> }
  storage:
    | { type: 's3'; url: string; endpoint: string; credentialsSecret: string }
    | { type: 'pvc'; claimName: string }
  /** Defaults for join. */
  maxMinutes?: number
  aloneMinutes?: number
}

export interface JoinRequest {
  url: string
  profile: string
  title?: string
  language?: string
  maxMinutes?: number
  aloneMinutes?: number
}

/** The PVC holding an account's Chrome profile (its Google session). */
export function profileClaimName(profile: string): string {
  return `meeting-recorder-profile-${profile.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
}

export function parseSettings(raw: string): ClusterSettings {
  const s = JSON.parse(raw) as ClusterSettings
  if (!s.image) throw new Error(`${SETTINGS_CONFIGMAP} has no image.`)
  if (s.storage?.type === 's3' && !(s.storage.url && s.storage.endpoint && s.storage.credentialsSecret)) {
    throw new Error(`${SETTINGS_CONFIGMAP}: s3 storage needs url, endpoint and credentialsSecret.`)
  }
  if (s.storage?.type === 'pvc' && !s.storage.claimName) throw new Error(`${SETTINGS_CONFIGMAP}: pvc storage needs claimName.`)
  if (s.storage?.type !== 's3' && s.storage?.type !== 'pvc') throw new Error(`${SETTINGS_CONFIGMAP}: storage.type must be s3 or pvc.`)
  return s
}

export function buildJob(settings: ClusterSettings, req: JoinRequest): Record<string, unknown> {
  const maxMinutes = req.maxMinutes ?? settings.maxMinutes ?? 240
  const args = ['join', req.url, '--profile', req.profile, '--max', String(maxMinutes)]
  if (req.title) args.push('--title', req.title)
  if (req.language) args.push('--language', req.language)
  const alone = req.aloneMinutes ?? settings.aloneMinutes
  if (alone) args.push('--alone', String(alone))

  const env: Record<string, unknown>[] = [
    { name: 'HOME', value: '/tmp/home' },
    { name: 'MEETING_RECORDER_PROFILES', value: '/profiles' },
    { name: 'MEETING_RECORDER_OUT', value: '/recordings' }
  ]
  if (settings.timeZone) env.push({ name: 'TZ', value: settings.timeZone })

  const volumes: Record<string, unknown>[] = [
    { name: 'profiles', persistentVolumeClaim: { claimName: profileClaimName(req.profile) } },
    // Chrome needs a large /dev/shm; the default 64 MiB makes it crash.
    { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } },
    { name: 'tmp', emptyDir: {} }
  ]
  const mounts: Record<string, unknown>[] = [
    { name: 'profiles', mountPath: '/profiles' },
    { name: 'shm', mountPath: '/dev/shm' },
    { name: 'tmp', mountPath: '/tmp' }
  ]

  if (settings.storage.type === 's3') {
    args.push('--upload', settings.storage.url)
    env.push({ name: 'S3_ENDPOINT', value: settings.storage.endpoint })
    for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      env.push({ name: key, valueFrom: { secretKeyRef: { name: settings.storage.credentialsSecret, key } } })
    }
    // Files are written locally, then uploaded.
    volumes.push({ name: 'recordings', emptyDir: {} })
  } else {
    volumes.push({ name: 'recordings', persistentVolumeClaim: { claimName: settings.storage.claimName } })
  }
  mounts.push({ name: 'recordings', mountPath: '/recordings' })

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      generateName: 'meeting-recorder-',
      labels: { [APP_LABEL]: APP, [PROFILE_LABEL]: req.profile },
      annotations: { 'meeting-recorder/url': req.url, ...(req.title ? { 'meeting-recorder/title': req.title } : {}) }
    },
    spec: {
      // A retry would ask to join the meeting again: a failure is looked at by hand.
      backoffLimit: 0,
      activeDeadlineSeconds: (maxMinutes + 10) * 60,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: { labels: { [APP_LABEL]: APP, [PROFILE_LABEL]: req.profile } },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          // SIGTERM stops the recording; finishing and uploading an hour of video takes a while.
          terminationGracePeriodSeconds: 300,
          ...(settings.imagePullSecret ? { imagePullSecrets: [{ name: settings.imagePullSecret }] } : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' }
          },
          containers: [
            {
              name: 'recorder',
              image: settings.image,
              args,
              env,
              resources: settings.resources ?? {
                requests: { cpu: '1', memory: '1536Mi' },
                limits: { cpu: '2', memory: '3Gi' }
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] }
              },
              volumeMounts: mounts
            }
          ],
          volumes
        }
      }
    }
  }
}
