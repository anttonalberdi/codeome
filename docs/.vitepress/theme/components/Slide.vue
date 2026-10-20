<!--
  <Slide> : one slide of a <SlideDeck>. The deck shows one slide at a time and never scrolls,
  so keep a slide to a short list or a few lines. A <Shot> in the body goes in a second
  column next to the text.

  Props
    title  heading shown at the top of the slide
    step   optional small label above the title, e.g. "Step 2 · Set up"
    more   optional link to the detailed page, e.g. "/guide/agent-chat"
    label  optional text for that link (default "Read the details")
-->
<script setup>
import { withBase } from 'vitepress'

defineProps({
  title: { type: String, required: true },
  step: { type: String, default: '' },
  more: { type: String, default: '' },
  label: { type: String, default: 'Read the details' }
})
</script>

<template>
  <section class="slide">
    <p v-if="step" class="slide-step">{{ step }}</p>
    <h2 class="slide-title">{{ title }}</h2>
    <div class="slide-body vp-doc"><slot /></div>
    <p v-if="more" class="slide-more"><a :href="withBase(more)">{{ label }} →</a></p>
  </section>
</template>

<style scoped>
.slide { min-height: 0; display: flex; flex-direction: column; }
.slide-step { margin: 0 0 6px; font-size: clamp(12px, 1.1vw, 14px); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vp-c-brand-1); }
.slide-title { margin: 0 0 clamp(10px, 2vh, 22px); padding: 0; border: 0; font-size: clamp(24px, min(3.2vw, 5.2vh), 44px); line-height: 1.15; letter-spacing: -0.02em; }
.slide-body {
  font-size: clamp(14px, min(1.5vw, 2.5vh), 22px); line-height: 1.5;
  display: grid; grid-template-columns: minmax(0, 1fr); column-gap: clamp(20px, 3vw, 48px); align-items: center;
}
.slide-body:has(figure) { grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); }
.slide-body :deep(> *) { grid-column: 1; margin-top: 0; margin-bottom: 0.55em; }
.slide-body :deep(> figure) { grid-column: 2; grid-row: 1 / span 12; margin: 0; }
.slide-body :deep(.shot-btn img) { max-height: calc(100vh - var(--vp-nav-height, 64px) - 250px); object-fit: contain; }
.slide-body :deep(ul), .slide-body :deep(ol) { padding-left: 1.2em; }
.slide-body :deep(li + li) { margin-top: 0.35em; }
.slide-body :deep(table) { display: table; font-size: 0.85em; }
.slide-more { margin: clamp(8px, 2vh, 20px) 0 0; font-size: clamp(14px, 1.2vw, 16px); font-weight: 500; }
.slide-more a { color: var(--vp-c-brand-1); text-decoration: none; }
.slide-more a:hover { text-decoration: underline; }
@media (max-width: 860px) {
  .slide-body:has(figure) { grid-template-columns: minmax(0, 1fr); }
  .slide-body :deep(> figure) { display: none; }
}
</style>
