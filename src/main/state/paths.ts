import { app } from 'electron'
import { join } from 'node:path'

export function getLibraryFilePath(): string {
  return join(app.getPath('userData'), 'library.json')
}

export function getDecisionsFilePath(): string {
  return join(app.getPath('userData'), 'decisions.json')
}

export function getArtDir(): string {
  return join(app.getPath('userData'), 'art')
}

export function getSettingsFilePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}
