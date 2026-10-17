<!--
  Home hero screenshot (used by theme/index.js in the home-hero-after slot).
  Shows /screens/home-hero.webp (dark) or /screens/home-hero-light.webp (light),
  following the site theme through CSS on the <html class="dark"> toggle.
  If the dark file is missing the whole block is removed; a missing light file
  falls back to the dark one. Images are 2x; width/height set the aspect ratio.
-->
<script setup>
import { ref } from 'vue'
import { withBase } from 'vitepress'
import { lightSrc } from '../themeSrc.js'

const SRC = '/screens/home-hero.webp'
const failed = ref(false)
const lightFailed = ref(false)
</script>

<template>
  <div v-if="!failed" class="hero-shot">
    <div class="shot-frame">
      <img
        class="theme-img theme-img-dark"
        :src="withBase(SRC)"
        alt="The Codeome app window showing projects, agent chats and the editor"
        width="1500"
        height="940"
        decoding="async"
        @error="failed = true"
      />
      <img
        class="theme-img theme-img-light"
        :src="withBase(lightFailed ? SRC : lightSrc(SRC))"
        alt="The Codeome app window showing projects, agent chats and the editor"
        width="1500"
        height="940"
        loading="lazy"
        decoding="async"
        @error="lightFailed = true"
      />
    </div>
  </div>
</template>

<style scoped>
.hero-shot { max-width: 1100px; margin: 8px auto 0; padding: 0 24px 24px; }
.shot-frame {
  border: 1px solid var(--vp-c-divider); border-radius: 10px; overflow: hidden;
  background: var(--vp-c-bg-soft);
  box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.55);
}
.shot-frame img { display: block; width: 100%; max-width: 100%; height: auto; aspect-ratio: 1500 / 940; }
</style>

<style>
/* theme swap: keyed on the class VitePress sets on <html>; hidden lazy images are not fetched */
.theme-img-light { display: none !important; }
html:not(.dark) .theme-img-dark { display: none !important; }
html:not(.dark) .theme-img-light { display: block !important; }
</style>
