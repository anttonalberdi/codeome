<!--
  <Shot> : a screenshot in a window frame with caption and click-to-zoom.

  Props
    src      (required) path under docs/public, e.g. "/screens/chats.png"
    alt      (required) description for screen readers (warns in dev if empty)
    caption  optional text under the image
    bare     optional: no window bar, only border and shadow (detail crops)
    width, height  optional intrinsic size, reserves space (no layout shift)

  Usage
    <Shot src="/screens/chats.png" alt="Agent chat with two sessions"
          caption="Chats sit next to the editor." width="1440" height="900" />
    <Shot bare src="/screens/popover.png" alt="Usage popover" />

  The image is a button: Enter/Space or click opens a lightbox; Esc or click closes.
-->
<script setup>
import { ref, nextTick, onMounted } from 'vue'
import { withBase } from 'vitepress'

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

onMounted(() => {
  const probe = new Image()
  probe.onerror = () => { failed.value = true }
  probe.src = withBase(props.src)
  if (import.meta.env.DEV && !props.alt) console.warn(`<Shot src="${props.src}"> is missing alt text`)
})

async function open() {
  await nextTick()
  if (dlg.value && !dlg.value.open) dlg.value.showModal()
}
function close() {
  dlg.value?.close()
}
</script>

<template>
  <figure class="shot" :class="{ bare }">
    <div class="shot-frame">
      <div v-if="!bare" class="shot-bar" aria-hidden="true"><i /><i /><i /></div>
      <button v-if="!failed" type="button" class="shot-btn" :aria-label="`Enlarge image: ${alt}`" @click="open">
        <img
          :src="withBase(src)"
          :alt="alt"
          :width="width"
          :height="height"
          loading="lazy"
          decoding="async"
          @error="failed = true"
        />
      </button>
      <div v-else class="shot-missing" role="img" :aria-label="alt">Screenshot not available yet</div>
    </div>
    <figcaption v-if="caption">{{ caption }}</figcaption>

    <dialog ref="dlg" class="shot-dialog" :aria-label="alt || 'Enlarged screenshot'" @click="close" @cancel="close">
      <img :src="withBase(src)" :alt="alt" />
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
}
.bare .shot-frame { border-radius: 8px; box-shadow: 0 8px 22px -12px rgba(0, 0, 0, 0.45); }
.shot-bar { display: flex; gap: 6px; padding: 8px 12px; background: var(--vp-c-bg-alt); border-bottom: 1px solid var(--vp-c-divider); }
.shot-bar i { width: 9px; height: 9px; border-radius: 50%; background: var(--vp-c-divider); }
.shot-bar i:nth-child(1) { background: #fb7185; }
.shot-bar i:nth-child(2) { background: #fbbf24; }
.shot-bar i:nth-child(3) { background: #34d399; }
.shot-btn { display: block; width: 100%; margin: 0; padding: 0; border: 0; background: none; cursor: zoom-in; }
.shot-btn:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: -2px; }
.shot-btn img { display: block; width: 100%; height: auto; }
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
