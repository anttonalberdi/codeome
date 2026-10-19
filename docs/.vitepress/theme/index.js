import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import Shot from './components/Shot.vue'
import ShotRow from './components/ShotRow.vue'
import HeroShot from './components/HeroShot.vue'
import DownloadButtons from './components/DownloadButtons.vue'
import SlideDeck from './components/SlideDeck.vue'
import Slide from './components/Slide.vue'
import SiteFooter from './components/SiteFooter.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      // App screenshot under the hero; hides itself while the image is missing.
      'home-hero-after': () => h(HeroShot),
      'home-hero-actions-after': () => h(DownloadButtons),
      'layout-bottom': () => h(SiteFooter)
    })
  },
  enhanceApp({ app }) {
    app.component('Shot', Shot)
    app.component('ShotRow', ShotRow)
    app.component('SlideDeck', SlideDeck)
    app.component('Slide', Slide)
  }
}
