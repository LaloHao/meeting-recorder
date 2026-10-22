// Assembles the loadable extension in dist/extension: extension/ plus the shared
// speaker detector it injects into Meet.
import { cpSync, rmSync } from 'node:fs'

rmSync('dist/extension', { recursive: true, force: true })
cpSync('extension', 'dist/extension', { recursive: true })
cpSync('shared', 'dist/extension/shared', { recursive: true })
console.log('Extension ready in dist/extension (chrome://extensions → Load unpacked).')
