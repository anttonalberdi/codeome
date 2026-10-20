<!--
  <SlideDeck> : a slideshow built from <Slide> children, one visible at a time.

  Navigation: the buttons, the dots, ← / → (also PageUp/PageDown, Space), Home / End,
  and F for full screen. The current slide is kept in the URL hash (#3), so a slide can
  be linked to and the back button leaves the deck rather than stepping through it.

  The deck fills the window below the site nav (no page scrolling): the slide on a
  large stage, big arrows on the left and right edges, a progress bar, swipe on touch.

  Usage
    <SlideDeck title="Getting started">
      <Slide title="Welcome" more="/guide/getting-started">
      Text, lists or a <Shot> in Markdown. Leave a blank line after the tag.
      </Slide>
    </SlideDeck>
-->
<script setup>
import { ref, computed, useSlots, onMounted, onBeforeUnmount, Comment, Text, Fragment } from 'vue'

const props = defineProps({ title: { type: String, default: '' } })
const slots = useSlots()
const root = ref(null)
const index = ref(0)
const fullscreen = ref(false)
const dir = ref('next')
let touchX = null

function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.type === Fragment) flatten(n.children, out)
    else if (n.type !== Comment && n.type !== Text) out.push(n)
  }
  return out
}
const slides = computed(() => flatten(slots.default?.()))
const count = computed(() => slides.value.length)
const current = computed(() => slides.value[index.value])

function go(i) {
  if (!count.value) return
  dir.value = i >= index.value ? 'next' : 'prev'
  index.value = Math.min(Math.max(i, 0), count.value - 1)
  history.replaceState(null, '', `#${index.value + 1}`)
}
const next = () => go(index.value + 1)
const prev = () => go(index.value - 1)

function onTouchStart(e) { touchX = e.changedTouches[0].clientX }
function onTouchEnd(e) {
  if (touchX === null) return
  const dx = e.changedTouches[0].clientX - touchX
  touchX = null
  if (Math.abs(dx) > 50) (dx < 0 ? next : prev)()
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.()
  else root.value?.requestFullscreen?.()
}
function onFullscreenChange() {
  fullscreen.value = document.fullscreenElement === root.value
}
function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const t = e.target
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && t === document.body)) { next(); e.preventDefault() }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { prev(); e.preventDefault() }
  else if (e.key === 'Home') { go(0); e.preventDefault() }
  else if (e.key === 'End') { go(count.value - 1); e.preventDefault() }
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen()
}

onMounted(() => {
  const n = Number.parseInt(location.hash.slice(1), 10)
  if (Number.isFinite(n)) index.value = Math.min(Math.max(n - 1, 0), Math.max(count.value - 1, 0))
  window.addEventListener('keydown', onKey)
  document.addEventListener('fullscreenchange', onFullscreenChange)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
})
</script>

<template>
  <div ref="root" class="deck" :class="{ full: fullscreen }" role="region" aria-roledescription="slideshow" :aria-label="title || 'Slideshow'">
    <div class="deck-progress" aria-hidden="true"><span :style="{ width: `${((index + 1) / Math.max(count, 1)) * 100}%` }" /></div>
    <div class="deck-main" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
      <button type="button" class="deck-side left" :disabled="index === 0" aria-label="Previous slide" @click="prev">‹</button>
      <div class="deck-stage" aria-live="polite">
        <Transition :name="`slide-${dir}`" mode="out-in">
          <component :is="current" :key="index" />
        </Transition>
      </div>
      <button type="button" class="deck-side right" :disabled="index >= count - 1" aria-label="Next slide" @click="next">›</button>
    </div>
    <div class="deck-bar">
      <span class="deck-title">{{ title }}</span>
      <div class="deck-dots" role="tablist" aria-label="Slides">
        <button
          v-for="(_, i) in slides"
          :key="i"
          type="button"
          role="tab"
          class="deck-dot"
          :class="{ on: i === index }"
          :aria-selected="i === index"
          :aria-label="`Slide ${i + 1} of ${count}`"
          @click="go(i)"
        />
      </div>
      <span class="deck-count">{{ index + 1 }} / {{ count }}</span>
      <button type="button" class="deck-btn" :aria-label="fullscreen ? 'Leave full screen' : 'Full screen'" title="Full screen (F)" @click="toggleFullscreen">
        {{ fullscreen ? '⤡' : '⤢' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.deck {
  height: calc(100vh - var(--vp-nav-height, 64px)); min-height: 440px;
  display: flex; flex-direction: column; background: var(--vp-c-bg);
}
.deck-progress { height: 3px; background: var(--vp-c-divider); flex: none; }
.deck-progress span { display: block; height: 100%; background: var(--vp-c-brand-1); transition: width 0.25s ease; }
.deck-main { flex: 1; min-height: 0; display: flex; align-items: stretch; }
.deck-stage {
  flex: 1; min-width: 0; overflow-x: hidden; overflow-y: auto; display: flex; flex-direction: column; justify-content: center;
  padding: clamp(16px, 4vh, 48px) clamp(8px, 2vw, 32px); max-width: 1280px; margin: 0 auto;
}
.deck-side {
  flex: none; width: clamp(44px, 6vw, 84px); border: 0; background: none; cursor: pointer;
  font-size: clamp(36px, 5vw, 64px); line-height: 1; color: var(--vp-c-text-3);
}
.deck-side:hover:not(:disabled) { color: var(--vp-c-brand-1); background: var(--vp-c-bg-soft); }
.deck-side:disabled { opacity: 0.18; cursor: default; }
.deck-side:focus-visible, .deck-btn:focus-visible, .deck-dot:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: -2px; }
.deck-bar {
  flex: none; display: flex; align-items: center; gap: 14px; padding: 8px 16px;
  border-top: 1px solid var(--vp-c-divider); background: var(--vp-c-bg-soft);
}
.deck-title { flex: 1; font-size: 13px; font-weight: 600; color: var(--vp-c-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.deck-dots { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px; }
.deck-dot { width: 20px; height: 24px; padding: 0; border: 0; background: none; cursor: pointer; position: relative; }
.deck-dot::after { content: ''; position: absolute; inset: 8px 6px; border-radius: 50%; background: var(--vp-c-border); }
.deck-dot.on::after { background: var(--vp-c-brand-1); inset: 6px 4px; }
.deck-count { font-size: 13px; color: var(--vp-c-text-2); font-variant-numeric: tabular-nums; }
.deck-btn {
  min-width: 32px; height: 32px; border-radius: 8px; font-size: 15px; cursor: pointer;
  border: 1px solid var(--vp-c-border); background: var(--vp-c-bg-elv); color: var(--vp-c-text-1);
}
.deck-btn:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }

.slide-next-enter-active, .slide-next-leave-active, .slide-prev-enter-active, .slide-prev-leave-active { transition: opacity 0.14s ease, transform 0.14s ease; }
.slide-next-enter-from, .slide-prev-leave-to { opacity: 0; transform: translateX(24px); }
.slide-next-leave-to, .slide-prev-enter-from { opacity: 0; transform: translateX(-24px); }
@media (prefers-reduced-motion: reduce) {
  .slide-next-enter-active, .slide-next-leave-active, .slide-prev-enter-active, .slide-prev-leave-active { transition: none; }
}

.deck.full { position: fixed; inset: 0; height: 100vh; z-index: 100; }
.deck.full .deck-stage { max-width: 1500px; }
@media (max-width: 720px) {
  .deck-side { display: none; }
  .deck-dots, .deck-title { display: none; }
  .deck-count { flex: 1; }
}
</style>
