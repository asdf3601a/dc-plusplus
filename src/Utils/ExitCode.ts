// Exit code for a stop that needs the operator before the bot can run: the startup data check failed
// (run `pnpm migrate`), or config.json was just created, migrated or is newer than this build
// (EX_CONFIG in sysexits.h). ecosystem.config.js lists it in stop_exit_codes so pm2 does not restart
// into the same stop.
export const EXIT_NO_RESTART = 78
