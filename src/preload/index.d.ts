import type { IrisApi } from './index'

declare global {
  interface Window {
    iris: IrisApi
  }
}
