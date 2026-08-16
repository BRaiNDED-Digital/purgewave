import type { PurgeWaveApi } from './index'

declare global {
  interface Window {
    purgewave: PurgeWaveApi
  }
}
