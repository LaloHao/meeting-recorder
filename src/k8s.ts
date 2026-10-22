// `meeting-recorder k8s …`: run recordings as Jobs in a Kubernetes cluster, with
// kubectl and the current context (the person's kubeconfig). Nothing is exposed:
// the CLI talks to the API server like kubectl does.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { APP, APP_LABEL, buildJob, parseSettings, PROFILE_LABEL, profileClaimName, SETTINGS_CONFIGMAP, type JoinRequest } from './k8s-job.js'

export interface KubeOptions {
  namespace: string
  context?: string
}

function kubectlArgs(opts: KubeOptions, args: string[]): string[] {
  return [...(opts.context ? ['--context', opts.context] : []), '--namespace', opts.namespace, ...args]
}

/** Runs kubectl and returns stdout; throws with kubectl's message on failure. */
export function kubectl(opts: KubeOptions, args: string[], input?: string): string {
  const r = spawnSync('kubectl', kubectlArgs(opts, args), { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Error(`kubectl is needed for the k8s commands (${r.error.message}).`)
  if (r.status !== 0) throw new Error(r.stderr.trim() || `kubectl ${args[0]} failed`)
  return r.stdout
}

/** Runs kubectl attached to the terminal (logs -f). */
function kubectlLive(opts: KubeOptions, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', kubectlArgs(opts, args), { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

interface JobJson {
  metadata: { name: string; creationTimestamp: string; labels?: Record<string, string>; annotations?: Record<string, string> }
  status: { active?: number; succeeded?: number; failed?: number }
}

function jobs(opts: KubeOptions, selector = `${APP_LABEL}=${APP}`): JobJson[] {
  return (JSON.parse(kubectl(opts, ['get', 'jobs', '-l', selector, '-o', 'json'])) as { items: JobJson[] }).items
}

const state = (j: JobJson): string => (j.status.active ? 'recording' : j.status.succeeded ? 'done' : j.status.failed ? 'failed' : 'starting')

/** Creates the Job of a recording; returns its name. */
export function k8sJoin(opts: KubeOptions, req: JoinRequest): string {
  // One recording per account at a time: two copies of a Google session in use make Google end it.
  const busy = jobs(opts, `${PROFILE_LABEL}=${req.profile}`).filter((j) => state(j) === 'recording' || state(j) === 'starting')
  if (busy.length) {
    throw new Error(`Profile "${req.profile}" is already recording (${busy.map((j) => j.metadata.name).join(', ')}); one recording per account at a time.`)
  }
  kubectl(opts, ['get', 'pvc', profileClaimName(req.profile)]).trim() // fails clearly if the profile was never seeded
  const raw = kubectl(opts, ['get', 'configmap', SETTINGS_CONFIGMAP, '-o', 'jsonpath={.data.settings\\.json}'])
  const job = buildJob(parseSettings(raw), req)
  return kubectl(opts, ['create', '-f', '-', '-o', 'jsonpath={.metadata.name}'], JSON.stringify(job)).trim()
}

export function k8sList(opts: KubeOptions): string {
  const rows = jobs(opts)
    .sort((a, b) => b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp))
    .map((j) => [j.metadata.name, state(j), j.metadata.labels?.[PROFILE_LABEL] ?? '', j.metadata.creationTimestamp, j.metadata.annotations?.['meeting-recorder/url'] ?? ''])
  if (rows.length === 0) return 'No recordings.'
  const header = ['JOB', 'STATE', 'PROFILE', 'CREATED', 'MEETING']
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  return [header, ...rows].map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n')
}

export function k8sLogs(opts: KubeOptions, job: string, follow: boolean): Promise<number> {
  return kubectlLive(opts, ['logs', ...(follow ? ['-f'] : []), `job/${job}`])
}

/** Deleting the Job sends SIGTERM to the agent, which stops, saves and uploads before exiting. */
export function k8sStop(opts: KubeOptions, job: string): void {
  kubectl(opts, ['delete', 'job', job, '--wait=false'])
}

/**
 * Moves an exported session into the account's profile PVC: creates the PVC if
 * needed, unpacks the archive into it from a short-lived Pod running the agent's
 * image, and removes that Pod.
 */
export async function k8sSeedProfile(opts: KubeOptions, profile: string, archive: Buffer, log: (m: string) => void): Promise<void> {
  const settings = parseSettings(kubectl(opts, ['get', 'configmap', SETTINGS_CONFIGMAP, '-o', 'jsonpath={.data.settings\\.json}']))
  const claim = profileClaimName(profile)
  kubectl(
    opts,
    ['apply', '-f', '-'],
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: claim, labels: { [APP_LABEL]: APP, [PROFILE_LABEL]: profile } },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } }
    })
  )
  const pod = `${claim}-seed`
  kubectl(opts, ['delete', 'pod', pod, '--ignore-not-found', '--wait=true'])
  kubectl(
    opts,
    ['apply', '-f', '-'],
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: pod, labels: { [APP_LABEL]: APP } },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        ...(settings.imagePullSecret ? { imagePullSecrets: [{ name: settings.imagePullSecret }] } : {}),
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [
          {
            name: 'seed',
            image: settings.image,
            command: ['sleep', '600'],
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
            volumeMounts: [{ name: 'profiles', mountPath: '/profiles' }]
          }
        ],
        volumes: [{ name: 'profiles', persistentVolumeClaim: { claimName: claim } }]
      }
    })
  )
  try {
    log('Waiting for the seed Pod…')
    kubectl(opts, ['wait', '--for=condition=Ready', `pod/${pod}`, '--timeout=180s'])
    const dir = mkdtempSync(join(tmpdir(), 'meeting-recorder-seed-'))
    const local = join(dir, 'session.tgz')
    writeFileSync(local, archive, { mode: 0o600 })
    try {
      // kubectl cp needs a relative local path on some platforms; run it from the temp folder.
      const cp = spawnSync('kubectl', kubectlArgs(opts, ['cp', 'session.tgz', `${pod}:/tmp/session.tgz`]), { cwd: dir, encoding: 'utf8' })
      if (cp.status !== 0) throw new Error(cp.stderr.trim() || 'kubectl cp failed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // The previous session (if any) is replaced, not merged.
    kubectl(opts, [
      'exec', pod, '--', 'sh', '-c',
      `rm -rf "/profiles/${profile}" && mkdir -m 700 "/profiles/${profile}" && tar -xzf /tmp/session.tgz -C "/profiles/${profile}" && rm /tmp/session.tgz`
    ])
    log(`Session moved into PVC ${claim}.`)
  } finally {
    kubectl(opts, ['delete', 'pod', pod, '--ignore-not-found', '--wait=false'])
  }
}
