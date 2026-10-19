<!--
  <Slide> : one slide of a <SlideDeck>. The deck shows one slide at a time.

  Props
    title  heading shown at the top of the slide
    more   optional link to the detailed page, e.g. "/guide/agent-chat"
    label  optional text for that link (default "Read the details")
-->
<script setup>
import { withBase } from 'vitepress'

defineProps({
  title: { type: String, required: true },
  more: { type: String, default: '' },
  label: { type: String, default: 'Read the details' }
})
</script>

<template>
  <section class="slide">
    <h2 class="slide-title">{{ title }}</h2>
    <div class="slide-body vp-doc"><slot /></div>
    <p v-if="more" class="slide-more"><a :href="withBase(more)">{{ label }} →</a></p>
  </section>
</template>

<style scoped>
.slide-title { margin: 0 0 18px; padding: 0; border: 0; font-size: 28px; line-height: 1.25; letter-spacing: -0.01em; }
.slide-body { font-size: 17px; line-height: 1.65; }
.slide-body :deep(> :first-child) { margin-top: 0; }
.slide-body :deep(ul), .slide-body :deep(ol) { margin: 12px 0; }
.slide-body :deep(li + li) { margin-top: 6px; }
.slide-more { margin: 22px 0 0; font-size: 15px; font-weight: 500; }
.slide-more a { color: var(--vp-c-brand-1); text-decoration: none; }
.slide-more a:hover { text-decoration: underline; }
</style>
