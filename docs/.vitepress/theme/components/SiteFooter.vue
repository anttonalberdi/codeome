<script setup>
import { onMounted } from 'vue'
import { withBase } from 'vitepress'
import { version, refreshVersion, RELEASES } from '../release.js'

onMounted(refreshVersion)
const year = new Date().getFullYear()
</script>

<template>
  <footer class="site-footer">
    <div class="inner">
      <div class="brand">
        <img class="logo-light" :src="withBase('/logo.svg')" alt="" width="28" height="28" />
        <img class="logo-dark" :src="withBase('/logo-dark.svg')" alt="" width="28" height="28" />
        <div>
          <strong>Codeome</strong>
          <p>One Mac app for research computing, from your laptop to the HPC.</p>
        </div>
      </div>
      <nav class="cols" aria-label="Footer">
        <div>
          <h4>Product</h4>
          <a :href="RELEASES">Download<span v-if="version"> v{{ version }}</span></a>
          <a href="https://github.com/anttonalberdi/codeome/blob/main/CHANGELOG.md">Changelog</a>
          <a :href="RELEASES.replace('/latest', '')">All releases</a>
        </div>
        <div>
          <h4>Docs</h4>
          <a :href="withBase('/guide/getting-started')">Getting started</a>
          <a :href="withBase('/settings')">Settings</a>
          <a :href="withBase('/reference/keyboard')">Reference</a>
        </div>
        <div>
          <h4>Project</h4>
          <a href="https://github.com/anttonalberdi/codeome">GitHub</a>
          <a href="https://github.com/anttonalberdi/codeome/issues">Report an issue</a>
          <a href="https://github.com/anttonalberdi/codeome/blob/main/CONTRIBUTING.md">Contributing</a>
        </div>
      </nav>
    </div>
    <div class="legal">
      <span>© {{ year }} Antton Alberdi · Released under the MIT license</span>
      <span v-if="version">Latest version v{{ version }}</span>
    </div>
  </footer>
</template>

<style scoped>
.site-footer { border-top: 1px solid var(--vp-c-divider); background: var(--vp-c-bg-alt); padding: 40px 24px 20px; position: relative; z-index: 2; }
.inner, .legal { max-width: 1152px; margin: 0 auto; }
.inner { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 32px; }
.brand { display: flex; gap: 12px; max-width: 300px; }
.brand p { margin: 4px 0 0; font-size: 13px; color: var(--vp-c-text-2); line-height: 1.5; }
.logo-dark { display: none; }
:global(.dark) .logo-light { display: none; }
:global(.dark) .logo-dark { display: block; }
.cols { display: flex; gap: 56px; flex-wrap: wrap; }
.cols h4 { margin: 0 0 10px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--vp-c-text-3); }
.cols a { display: block; font-size: 14px; color: var(--vp-c-text-2); text-decoration: none; padding: 3px 0; }
.cols a:hover { color: var(--vp-c-brand-1); }
.legal { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--vp-c-divider); font-size: 12px; color: var(--vp-c-text-3); }
</style>
