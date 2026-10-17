<!--
  Home hero screenshot (used by theme/index.js in the home-hero-after slot).
  Shows /screens/home-hero.png in a window frame. If the file is missing the
  whole block is removed, so the hero degrades to text + logo.
-->
<script setup>
import { ref, onMounted } from 'vue'
import { withBase } from 'vitepress'
const failed = ref(false)
// probe the file after mount: an error event on the SSR img can fire before hydration
onMounted(() => {
  const probe = new Image()
  probe.onerror = () => { failed.value = true }
  probe.src = withBase('/screens/home-hero.png')
})
</script>

<template>
  <div v-if="!failed" class="hero-shot">
    <div class="shot-frame">
      <div class="shot-bar" aria-hidden="true"><i /><i /><i /></div>
      <img
        :src="withBase('/screens/home-hero.png')"
        alt="The Codeome app window showing projects, agent chats and the editor"
        width="1440"
        height="900"
        decoding="async"
        @error="failed = true"
      />
    </div>
  </div>
</template>

<style scoped>
.hero-shot { max-width: 1100px; margin: 8px auto 0; padding: 0 24px 24px; }
.shot-frame {
  border: 1px solid var(--vp-c-divider); border-radius: 10px; overflow: hidden;
  background: var(--vp-c-bg-soft);
  box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.02);
}
.shot-bar { display: flex; gap: 6px; padding: 9px 12px; background: var(--vp-c-bg-alt); border-bottom: 1px solid var(--vp-c-divider); }
.shot-bar i { width: 10px; height: 10px; border-radius: 50%; background: var(--vp-c-divider); }
.shot-bar i:nth-child(1) { background: #fb7185; }
.shot-bar i:nth-child(2) { background: #fbbf24; }
.shot-bar i:nth-child(3) { background: #34d399; }
.shot-frame img { display: block; width: 100%; height: auto; aspect-ratio: 1440 / 900; }
</style>
