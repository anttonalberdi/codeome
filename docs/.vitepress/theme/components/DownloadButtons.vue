<!-- Home download block: the build for this Mac first, the other one as a link. -->
<script setup>
import { computed, onMounted, ref } from 'vue'
import { version, dmgUrl, refreshVersion, detectMacArch, RELEASES } from '../release.js'

const arch = ref('')
const isMac = ref(true)

onMounted(async () => {
  refreshVersion()
  isMac.value = /Macintosh|Mac OS X/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent)
  arch.value = await detectMacArch()
})

const label = { arm64: 'Apple silicon', x64: 'Intel' }
const primary = computed(() => arch.value || 'arm64')
const other = computed(() => (primary.value === 'arm64' ? 'x64' : 'arm64'))
</script>

<template>
  <div v-if="version" class="download">
    <div class="row">
      <a class="VPButton medium brand" :href="dmgUrl(version, primary)">
        Download v{{ version }} for {{ arch ? label[arch] : 'Apple silicon' }}
      </a>
      <a class="VPButton medium alt" href="/codeome/guide/getting-started">Get started</a>
      <a class="VPButton medium alt" href="https://github.com/anttonalberdi/codeome">GitHub</a>
    </div>
    <p class="note">
      <template v-if="!isMac">Codeome is a macOS app. </template>
      <template v-else-if="!arch">We couldn't tell which chip you have. </template>
      Also available for
      <a :href="dmgUrl(version, other)">{{ label[other] }}</a>
      · <a :href="RELEASES">all releases</a>
    </p>
  </div>
  <div v-else class="download">
    <div class="row"><a class="VPButton medium brand" :href="RELEASES">Download for Mac</a></div>
  </div>
</template>

<style scoped>
.download { padding-top: 32px; }
.row { display: flex; flex-wrap: wrap; gap: 12px; }
.note { margin: 12px 0 0; font-size: 13px; color: var(--vp-c-text-3); }
.note a { color: var(--vp-c-text-2); text-decoration: underline; text-underline-offset: 3px; }
.note a:hover { color: var(--vp-c-brand-1); }
.VPButton { display: inline-block; border: 1px solid transparent; border-radius: 8px; padding: 0 20px; line-height: 38px; font-size: 14px; font-weight: 600; text-decoration: none; transition: color .25s, border-color .25s, background-color .25s; }
.VPButton.brand { background: var(--vp-button-brand-bg); color: var(--vp-button-brand-text); }
.VPButton.brand:hover { background: var(--vp-button-brand-hover-bg); }
.VPButton.alt { border-color: var(--vp-c-border); color: var(--vp-c-text-1); }
.VPButton.alt:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
@media (min-width: 960px) { .download { padding-top: 32px; } }
@media (max-width: 959px) { .row { justify-content: center; } .note { text-align: center; } }
</style>
