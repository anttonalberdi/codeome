<!--
  <ShotRow> : two or three <Shot> side by side; stacks on narrow screens.

  Usage
    <ShotRow>
      <Shot bare src="/screens/a.webp" alt="First detail" caption="One" />
      <Shot bare src="/screens/b.webp" alt="Second detail" caption="Two" />
    </ShotRow>
-->
<template>
  <div class="shot-row"><slot /></div>
</template>

<style scoped>
.shot-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 16px; align-items: start; margin: 24px 0; }
.shot-row :deep(.shot) { margin: 0; }
@media (max-width: 640px) { .shot-row { grid-template-columns: 1fr; } }
</style>
