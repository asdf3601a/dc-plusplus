import { existsSync as exists } from 'node:fs'
import { Status } from 'status-client'
import { checkData, EXIT_DATA_CHECK_FAILED } from './Core/DataMigration'
import { Discord } from './Core/Discord/Core'
import { SQLiteCore } from './Core/SQLite/Core'
import { migrateMongoToSqlite } from './Core/SQLite/Migration'
import { instances } from './Utils/Instances'

let quitting = false

const logger = instances.mainLogger
logger.info('Starting...')
if (instances.config.debug) instances.mainLogger.settings.minLevel = 0 // Silly

const status = new Status('VoiceLog')

async function main() {
  if (!(await checkData())) process.exit(EXIT_DATA_CHECK_FAILED)

  // Initialize SQLite
  const db = new SQLiteCore()
  instances.db = db

  const dumpPath = process.env.MONGODB_DUMP_PATH ?? './mongo_dump.json'

  if (exists(dumpPath)) {
    // Attempt to migrate from MongoDB dump file if path is provided in .env
    logger.info(`MongoDB dump found: ${dumpPath}. Attempting data migration...`)
    await migrateMongoToSqlite(dumpPath)
  }

  // Since SQLite/Prisma is synchronous initialization for the client
  // (connection is lazy), we can start the bot immediately.
  const discord = new Discord()
  instances.discord = discord

  discord.start()
  status.set_status()
}

main().catch((err) => {
  instances.mainLogger.fatal(err)
  process.exit(1)
})

process.on('warning', (e) => {
  logger.warn(e.message)
})

// Graceful shutdown
const stop = () => {
  console.log()
  if (quitting) {
    logger.warn('Force quitting...')
    process.exit(1)
  }

  logger.info('Shutting down...')
  quitting = true

  const timeout = setTimeout(() => {
    logger.warn('Graceful shutdown timed out. Force quitting...')
    process.exit(1)
  }, 60 * 1000)

  const discordShutdown = instances.discord?.stop() ?? Promise.resolve()

  const dbShutdown = new Promise<void>((resolve) => {
    if (instances.db) {
      instances.db.close().then(() => resolve())
    } else {
      resolve()
    }
  })

  Promise.all([discordShutdown, dbShutdown]).then(() => {
    clearTimeout(timeout)
    logger.info('All services shut down gracefully. Exiting.')
    process.exit(0)
  })
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
