// Entry point of `pnpm migrate`, run after `prisma migrate deploy`: upgrades the app-side data
import { migrateData } from './Core/DataMigration'
import { instances } from './Utils/Instances'

migrateData()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    instances.mainLogger.fatal('Data migration failed:', error)
    process.exit(1)
  })
