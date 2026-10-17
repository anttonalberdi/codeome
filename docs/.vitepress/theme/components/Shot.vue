<!--
  <Shot> : a screenshot in a clean bordered frame with caption and click-to-zoom.

  Props
    src      (required) the DARK file under docs/public, e.g. "/screens/chats.webp".
             The light file is derived: "/screens/chats-light.webp". The site theme
             picks one (CSS on <html class="dark">, so it switches instantly and
             never mismatches on hydration). Any extension works. A missing light
             file falls back to the dark one.
    alt      (required) description for screen readers (warns in dev if empty)
    caption  optional text under the image
    bare     optional: same frame with a smaller radius, for detail crops
    width, height  optional CSS-pixel size of the image (files are 2x). Used for the
             aspect ratio (no layout shift); width also caps the display size, so
             small crops are never scaled up past it.

  Usage
    <Shot src="/screens/chats.webp" alt="Agent chat with two sessions"
          caption="Chats sit next to the editor." width="1500" height="940" />
    <Shot bare src="/screens/popover.webp" alt="Usage popover" width="400" height="300" />

  The image is a button: Enter/Space or click opens a lightbox (showing the variant
  for the current theme); Esc or click closes.
-->
<script setup>
import { ref, computed, nextTick, onMounted } from 'vue'
import { withBase, useData } from 'vitepress'
import { lightSrc } from '../themeSrc.js'

const props = defineProps({
  src: { type: String, required: true },
  alt: { type: String, default: '' },
  caption: { type: String, default: '' },
  bare: { type: Boolean, default: false },
  width: { type: [Number, String], default: undefined },
  height: { type: [Number, String], default: undefined }
})

const dlg = ref(null)
const failed = ref(false)
const lightFailed = ref(false)
const opened = ref(false)
const { isDark } = useData()
const darkUrl = computed(() => withBase(props.src))
const lightUrl = computed(() => (lightFailed.value ? darkUrl.value : withBase(lightSrc(props.src))))
const frameStyle = computed(() => {
  const w = Number.parseFloat(String(props.width))
  return Number.isFinite(w) && w > 0 ? { maxWidth: `${w}px` } : undefined
})

onMounted(() => {
  if (import.meta.env.DEV && !props.alt) console.warn(`<Shot src="${props.src}"> is missing alt text`)
})

async function open() {
  opened.value = true
  await nextTick()
  if (dlg.value && !dlg.value.open) dlg.value.showModal()
}
function close() {
  dlg.value?.close()
  opened.value = false
}
</script>

<template>
  <figure class="shot" :class="{ bare }">
    <div class="shot-frame" :style="frameStyle">
      <button v-if="!failed" type="button" class="shot-btn" :aria-label="`Enlarge image: ${alt}`" @click="open">
        <img
          class="theme-img theme-img-dark"
          :src="darkUrl"
          :alt="alt"
          :width="width"
          :height="height"
          loading="lazy"
          decoding="async"
          @error="failed = true"
        />
        <img
          class="theme-img theme-img-light"
          :src="lightUrl"
          :alt="alt"
          :width="width"
          :height="height"
          loading="lazy"
          decoding="async"
          @error="lightFailed = true"
        />
      </button>
      <div v-else class="shot-missing" role="img" :aria-label="alt">Screenshot not available yet</div>
    </div>
    <figcaption v-if="caption">{{ caption }}</figcaption>

    <dialog ref="dlg" class="shot-dialog" :aria-label="alt || 'Enlarged screenshot'" @click="close" @cancel="opened = false" @close="opened = false">
      <img v-if="opened" :src="isDark ? darkUrl : lightUrl" :alt="alt" />
      <button type="button" class="shot-close" aria-label="Close" @click.stop="close">&times;</button>
    </dialog>
  </figure>
</template>

<style scoped>
.shot { margin: 24px 0; }
.shot-frame {
  border: 1px solid var(--vp-c-divider); border-radius: 10px; overflow: hidden;
  background: var(--vp-c-bg-soft);
  box-shadow: 0 14px 36px -16px rgba(0, 0, 0, 0.5);
  margin-inline: auto;
}
.bare .shot-frame { border-radius: 8px; box-shadow: 0 8px 22px -12px rgba(0, 0, 0, 0.45); }
.shot-btn { display: block; width: 100%; margin: 0; padding: 0; border: 0; background: none; cursor: zoom-in; }
.shot-btn:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: -2px; }
.shot-btn img { display: block; width: 100%; max-width: 100%; height: auto; }
.shot-missing { padding: 36px 16px; text-align: center; font-size: 13px; color: var(--vp-c-text-3); }
figcaption { margin-top: 8px; font-size: 13px; line-height: 1.5; color: var(--vp-c-text-2); text-align: center; }

.shot-dialog { width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 24px; border: 0; background: rgba(8, 11, 15, 0.88); cursor: zoom-out; }
.shot-dialog[open] { display: flex; align-items: center; justify-content: center; }
.shot-dialog::backdrop { background: transparent; }
.shot-dialog img { max-width: 100%; max-height: 100%; border-radius: 8px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6); }
.shot-close {
  position: absolute; top: 14px; right: 18px; width: 36px; height: 36px; border-radius: 8px;
  border: 1px solid #3d4754; background: #20262e; color: #d9dee5; font-size: 22px; line-height: 1; cursor: pointer;
}
.shot-close:focus-visible { outline: 2px solid #9cc59f; outline-offset: 2px; }
</style>

<style>
/* theme swap: keyed on the class VitePress sets on <html>; hidden lazy images are not fetched */
.theme-img-light { display: none !important; }
html:not(.dark) .theme-img-dark { display: none !important; }
html:not(.dark) .theme-img-light { display: block !important; }
</style>
