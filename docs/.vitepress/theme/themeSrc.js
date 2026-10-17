// Theme-aware screenshots: the dark file is "/screens/x.webp", the light one "/screens/x-light.webp".
export function lightSrc(src) {
  return /\.[^./]+$/.test(src) ? src.replace(/(\.[^./]+)$/, '-light$1') : `${src}-light`
}
