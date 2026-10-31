import { existsSync as exists, readFileSync as readFile } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { instances } from '../Utils/Instances'

// MongoDB dumps store the TTS engine name, SQLite stores the provider id
const MONGO_TTS_PROVIDERS = new Map([
  ['WaveNet', 'google-cloud'],
  ['Legacy', 'google-translate']
])

const logger = instances.mainLogger.getSubLogger({ name: 'DBMigrate' })

// A serverConfig row read from the dump; ttsType is the MongoDB engine name, mapped to a provider on import
interface DumpRow {
  serverID: string
  lang: string
  channelID: string
  lastVoiceChannel: string
  currentVoiceChannel: string
  ttsEnabled: boolean
  ttsMessageLang: string
  ttsType: string | undefined
  ttsVoiceLang: string
  ttsVoiceName: string
}

// Throws, naming the first bad document, unless the whole dump parses and every field has the right type
function readMongoDump(dumpPath: string): DumpRow[] {
  const rawData = readFile(dumpPath, { encoding: 'utf-8' }).trim()
  let documents: unknown
  if (rawData.startsWith('[')) {
    documents = JSON.parse(rawData)
  } else if (rawData.includes('\n')) {
    documents = rawData
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
  } else {
    documents = JSON.parse(rawData)
  }

  // Handle both array of docs or mongoexport object format
  const dataArray: unknown[] = Array.isArray(documents) ? documents : [documents]
  return dataArray.map((doc, index) => toRow(doc, `Document ${index + 1}`))
}

// Missing or null fields get the defaults; any other value of the wrong type is an error
function toRow(doc: unknown, name: string): DumpRow {
  if (!isObject(doc) || typeof doc.serverID !== 'string' || doc.serverID === '') {
    throw new Error(`${name} has no serverID: ${JSON.stringify(doc)}`)
  }
  const where = `${name} (serverID ${doc.serverID})`
  const tts = doc.voiceMessageTTS ?? {}
  if (!isObject(tts)) throw new Error(`${where}: voiceMessageTTS is ${JSON.stringify(tts)}, expected an object`)
  const enabled = tts.enabled ?? false
  if (typeof enabled !== 'boolean') throw new Error(`${where}: voiceMessageTTS.enabled is ${JSON.stringify(enabled)}, expected a boolean`)
  const type = tts.type ?? undefined
  if (type !== undefined && typeof type !== 'string') throw new Error(`${where}: voiceMessageTTS.type is ${JSON.stringify(type)}, expected a string`)
  return {
    serverID: doc.serverID,
    lang: stringField(doc, 'lang', 'en_US', where),
    channelID: stringField(doc, 'channelID', '', where),
    lastVoiceChannel: stringField(doc, 'lastVoiceChannel', '', where),
    currentVoiceChannel: stringField(doc, 'currentVoiceChannel', '', where),
    ttsEnabled: enabled,
    ttsMessageLang: stringField(tts, 'messageLang', 'en_US', where, 'voiceMessageTTS.'),
    ttsType: type,
    ttsVoiceLang: stringField(tts, 'voiceLang', 'en-US', where, 'voiceMessageTTS.'),
    ttsVoiceName: stringField(tts, 'voiceName', 'en-US-Wavenet-A', where, 'voiceMessageTTS.')
  }
}

function stringField(object: Record<string, unknown>, key: string, fallback: string, where: string, prefix = '') {
  const value = object[key] ?? fallback
  if (typeof value !== 'string') throw new Error(`${where}: ${prefix}${key} is ${JSON.stringify(value)}, expected a string`)
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Run by `pnpm migrate` before `prisma migrate deploy` when there is a dump: the dump exists and every
// document is valid. Only reads.
export function preflightMongoDump(dumpPath: string): boolean {
  if (!exists(dumpPath)) {
    logger.error(`MongoDB dump ${dumpPath} not found; nothing was changed`)
    return false
  }
  try {
    readMongoDump(dumpPath)
    return true
  } catch (error) {
    logger.error(`MongoDB dump ${dumpPath} is not valid; nothing was changed:`, error)
    return false
  }
}

// Upserts every document by serverID in one transaction, so a failure writes nothing and running it again
// is safe, then deletes the dump. Returns false on failure.
export async function importMongoDump(dumpPath: string): Promise<boolean> {
  let rows: DumpRow[]
  try {
    rows = readMongoDump(dumpPath)
  } catch (error) {
    logger.error(`MongoDB dump ${dumpPath} is not valid; nothing was imported:`, error)
    return false
  }
  // Loaded here: importing the client creates the database directory, which --preflight must not do
  const { prisma } = await import('../Core/SQLite/Client')
  const { DEFAULT_TTS_PROVIDER } = await import('../Core/SQLite/db/ServerConfig')

  logger.info(`Found ${rows.length} documents in ${dumpPath}. Migrating to SQLite...`)
  const upserts = rows.map(({ serverID, ttsType, ...fields }) => {
    let ttsProvider = DEFAULT_TTS_PROVIDER
    if (ttsType !== undefined) {
      const mapped = MONGO_TTS_PROVIDERS.get(ttsType)
      if (mapped) {
        ttsProvider = mapped
      } else {
        logger.warn(`Guild ${serverID} has unknown TTS type "${ttsType}"; migrating to the default provider ${DEFAULT_TTS_PROVIDER}`)
      }
    }
    const dbObject = { ...fields, ttsProvider }
    return prisma.serverConfig.upsert({
      where: { serverID },
      update: dbObject,
      create: { serverID, ...dbObject }
    })
  })
  try {
    await prisma.$transaction(upserts)
  } catch (error) {
    logger.error('MongoDB dump migration failed; nothing was imported:', error)
    return false
  }
  logger.info('MongoDB dump migration completed!')

  try {
    await unlink(dumpPath)
    logger.info(`Deleted ${dumpPath}`)
    return true
  } catch (error) {
    logger.error(`The dump was imported, but deleting ${dumpPath} failed; move it away yourself (running \`pnpm migrate\` again is safe):`, error)
    return false
  }
}
