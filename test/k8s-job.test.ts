import { describe, expect, it } from 'vitest'

import { buildJob, parseSettings, profileClaimName, type ClusterSettings } from '../src/k8s-job.js'

const s3: ClusterSettings = {
  image: 'ghcr.io/lalohao/meeting-recorder:abc1234',
  imagePullSecret: 'ghcr-pull-secret',
  timeZone: 'America/Mexico_City',
  storage: { type: 's3', url: 's3://meeting-recordings', endpoint: 'https://acc.r2.cloudflarestorage.com', credentialsSecret: 'meeting-recorder-r2' }
}

type Job = {
  metadata: { labels: Record<string, string>; annotations: Record<string, string> }
  spec: {
    backoffLimit: number
    activeDeadlineSeconds: number
    template: {
      spec: {
        imagePullSecrets?: { name: string }[]
        securityContext: Record<string, unknown>
        containers: { args: string[]; env: { name: string; value?: string; valueFrom?: unknown }[]; securityContext: Record<string, unknown> }[]
        volumes: { name: string; persistentVolumeClaim?: { claimName: string }; emptyDir?: Record<string, string> }[]
      }
    }
  }
}

describe('recording Job', () => {
  it('records one meeting with the account profile, uploading to S3', () => {
    const job = buildJob(s3, { url: 'https://meet.google.com/abc-defg-hij', profile: 'bot', language: 'es', title: 'Daily' }) as Job
    const pod = job.spec.template.spec
    const [c] = pod.containers
    expect(c.args).toEqual([
      'join', 'https://meet.google.com/abc-defg-hij', '--profile', 'bot', '--max', '240',
      '--title', 'Daily', '--language', 'es', '--upload', 's3://meeting-recordings'
    ])
    expect(job.metadata.labels['meeting-recorder/profile']).toBe('bot')
    expect(job.spec.backoffLimit).toBe(0)
    expect(job.spec.activeDeadlineSeconds).toBe(250 * 60)
    expect(pod.imagePullSecrets).toEqual([{ name: 'ghcr-pull-secret' }])
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 10001 })
    expect(c.securityContext).toMatchObject({ readOnlyRootFilesystem: true, allowPrivilegeEscalation: false })
    expect(c.env.find((e) => e.name === 'TZ')?.value).toBe('America/Mexico_City')
    expect(c.env.find((e) => e.name === 'AWS_SECRET_ACCESS_KEY')?.valueFrom).toEqual({ secretKeyRef: { name: 'meeting-recorder-r2', key: 'AWS_SECRET_ACCESS_KEY' } })
    expect(pod.volumes.find((v) => v.name === 'profiles')?.persistentVolumeClaim?.claimName).toBe('meeting-recorder-profile-bot')
    expect(pod.volumes.find((v) => v.name === 'shm')?.emptyDir).toEqual({ medium: 'Memory', sizeLimit: '1Gi' })
  })

  it('writes to a PVC instead when storage is pvc', () => {
    const job = buildJob({ image: 'img', storage: { type: 'pvc', claimName: 'recordings' } }, { url: 'u', profile: 'bot', maxMinutes: 60, aloneMinutes: 5 }) as Job
    const pod = job.spec.template.spec
    expect(pod.containers[0].args).toEqual(['join', 'u', '--profile', 'bot', '--max', '60', '--alone', '5'])
    expect(pod.containers[0].args).not.toContain('--upload')
    expect(pod.volumes.find((v) => v.name === 'recordings')?.persistentVolumeClaim?.claimName).toBe('recordings')
    expect(pod.imagePullSecrets).toBeUndefined()
  })

  it('names profile claims safely and validates the settings', () => {
    expect(profileClaimName('Bot_2.work')).toBe('meeting-recorder-profile-bot-2-work')
    expect(parseSettings(JSON.stringify(s3)).image).toBe(s3.image)
    expect(() => parseSettings('{"storage":{"type":"s3"}}')).toThrow(/no image/)
    expect(() => parseSettings('{"image":"i","storage":{"type":"s3","url":"s3://b"}}')).toThrow(/endpoint/)
    expect(() => parseSettings('{"image":"i","storage":{"type":"nfs"}}')).toThrow(/s3 or pvc/)
  })
})
