import type { KeraiApi } from './index'

declare global {
  interface Window {
    kerai: KeraiApi
  }
}
