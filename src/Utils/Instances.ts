import { type ILogObj, Logger } from 'tslog'
import { Audio } from '../Audio/Audio'
import { GoogleCloudTTS } from '../Audio/Providers/GoogleCloudTTS'
import { GoogleTranslateTTS } from '../Audio/Providers/GoogleTranslateTTS'
import { OpenRouterTTS } from '../Audio/Providers/OpenRouterTTS'
import { XaiTTS } from '../Audio/Providers/XaiTTS'
import type { Discord } from '../Core/Discord/Core'
import type { SQLiteCore } from '../Core/SQLite/Core'
import { PluginManager } from '../Plugin/Core'
import { Config, loggerOptions } from './Config'
import { Lang } from './Lang'

interface INstances {
  mainLogger: Logger<ILogObj>
  config: Config
  lang: Lang
  audio: Audio
  pluginManager: PluginManager
  discord: Discord | undefined
  db: SQLiteCore | undefined
}

// Static instances
const mainLogger = new Logger(loggerOptions)
const config = new Config(mainLogger)
const lang = new Lang(mainLogger)
const pluginManager = new PluginManager(mainLogger)
// Composition root: register providers by id here (or inject one) without touching the audio module
const providers = [
  new GoogleTranslateTTS(mainLogger),
  new GoogleCloudTTS(() => config.googleTTS.apiKey, mainLogger),
  new XaiTTS(() => config.xaiTTS.apiKey, mainLogger),
  new OpenRouterTTS(() => config.openrouterTTS.apiKey, mainLogger)
]
const audio = new Audio(new Map(providers.map((provider) => [provider.id, provider])), pluginManager, mainLogger, {
  systemProvider: 'google-cloud'
})

export const instances: INstances = {
  mainLogger,
  config,
  lang,
  audio,
  pluginManager,
  discord: undefined,
  db: undefined
}
