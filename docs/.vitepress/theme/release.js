// Latest release info. The build-time version (from package.json) is the fallback;
// the GitHub API refreshes it in the browser so the site never lags behind a release.
import { ref } from 'vue'

export const REPO = 'anttonalberdi/codeome'
export const RELEASES = `https://github.com/${REPO}/releases/latest`

export const version = ref(typeof __CODEOME_VERSION__ === 'string' ? __CODEOME_VERSION__ : '')
let started = false

export function dmgUrl(v, arch) {
  const file = arch === 'arm64' ? `Codeome-${v}-arm64.dmg` : `Codeome-${v}.dmg`
  return `https://github.com/${REPO}/releases/download/v${v}/${file}`
}

export function refreshVersion() {
  if (started || typeof fetch === 'undefined') return
  started = true
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const v = j && typeof j.tag_name === 'string' ? j.tag_name.replace(/^v/, '') : ''
      if (/^\d+\.\d+\.\d+/.test(v)) version.value = v
    })
    .catch(() => {})
}

// 'arm64' | 'x64' | '' (unknown). Chromium exposes the CPU; Safari/Firefox hide it,
// so fall back to the WebGL renderer string, which names the GPU.
export async function detectMacArch() {
  const ua = navigator.userAgent
  if (!/Macintosh|Mac OS X/.test(ua) || /iPhone|iPad/.test(ua)) return ''
  try {
    const h = await navigator.userAgentData?.getHighEntropyValues?.(['architecture'])
    if (h?.architecture === 'arm') return 'arm64'
    if (h?.architecture === 'x86') {
      // Chrome on Apple silicon under Rosetta can still say x86; trust the GPU first.
      const g = gpu()
      return /apple/i.test(g) && !/intel/i.test(g) ? 'arm64' : 'x64'
    }
  } catch {}
  const g = gpu()
  if (/intel|amd|radeon/i.test(g)) return 'x64'
  if (/apple m\d|apple/i.test(g)) return 'arm64'
  return ''
}

function gpu() {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl')
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
  } catch {
    return ''
  }
}
