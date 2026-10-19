<!--
  <SlideDeck> : a slideshow built from <Slide> children, one visible at a time.

  Navigation: the buttons, the dots, ← / → (also PageUp/PageDown, Space), Home / End,
  and F for full screen. The current slide is kept in the URL hash (#3), so a slide can
  be linked to and the back button leaves the deck rather than stepping through it.

  Usage
    <SlideDeck>
      <Slide title="Welcome" more="/guide/getting-started">
      Text, lists or a <Shot> in Markdown. Leave a blank line after the tag.
      </Slide>
    </SlideDeck>
-->
<script setup>
import { ref, computed, useSlots, onMounted, onBeforeUnmount, Comment, Text, Fragment } from 'vue'

const slots = useSlots()
const root = ref(null)
const index = ref(0)
const fullscreen = ref(false)

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
  index.value = Math.min(Math.max(i, 0), count.value - 1)
  history.replaceState(null, '', `#${index.value + 1}`)
}
const next = () => go(index.value + 1)
const prev = () => go(index.value - 1)

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
  <div ref="root" class="deck" :class="{ full: fullscreen }" role="region" aria-roledescription="slideshow" aria-label="Slideshow">
    <div class="deck-stage" aria-live="polite">
      <component :is="current" :key="index" />
    </div>
    <div class="deck-bar">
      <button type="button" class="deck-btn" :disabled="index === 0" aria-label="Previous slide" @click="prev">←</button>
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
      <button type="button" class="deck-btn" :disabled="index >= count - 1" aria-label="Next slide" @click="next">→</button>
      <button type="button" class="deck-btn" :aria-label="fullscreen ? 'Leave full screen' : 'Full screen'" @click="toggleFullscreen">
        {{ fullscreen ? '⤡' : '⤢' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.deck {
  margin: 24px 0; border: 1px solid var(--vp-c-divider); border-radius: 12px;
  background: var(--vp-c-bg-soft); box-shadow: 0 14px 36px -16px rgba(0, 0, 0, 0.5);
  display: flex; flex-direction: column;
}
.deck-stage { padding: 36px 44px 20px; min-height: 440px; }
.deck-bar {
  display: flex; align-items: center; gap: 12px; padding: 12px 16px;
  border-top: 1px solid var(--vp-c-divider);
}
.deck-btn {
  min-width: 36px; height: 36px; padding: 0 10px; border-radius: 8px; font-size: 16px; cursor: pointer;
  border: 1px solid var(--vp-c-border); background: var(--vp-c-bg-elv); color: var(--vp-c-text-1);
}
.deck-btn:hover:not(:disabled) { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.deck-btn:disabled { opacity: 0.4; cursor: default; }
.deck-btn:focus-visible, .deck-dot:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.deck-dots { flex: 1; display: flex; flex-wrap: wrap; justify-content: center; gap: 2px; }
.deck-dot { width: 22px; height: 22px; padding: 0; border: 0; background: none; cursor: pointer; position: relative; }
.deck-dot::after {
  content: ''; position: absolute; inset: 7px; border-radius: 50%; background: var(--vp-c-border);
}
.deck-dot.on::after { background: var(--vp-c-brand-1); inset: 5px; }
.deck-count { font-size: 13px; color: var(--vp-c-text-2); font-variant-numeric: tabular-nums; }

.deck.full { border: 0; border-radius: 0; box-shadow: none; margin: 0; height: 100vh; background: var(--vp-c-bg); }
.deck.full .deck-stage { flex: 1; overflow: auto; padding: 5vh 8vw 2vh; max-width: 1200px; width: 100%; margin: 0 auto; }
.deck.full :deep(.slide-title) { font-size: 38px; }
.deck.full :deep(.slide-body) { font-size: 22px; }
@media (max-width: 640px) {
  .deck-stage { padding: 24px 18px 12px; min-height: 0; }
  .deck-dots { display: none; }
  .deck-count { flex: 1; text-align: center; }
}
</style>
