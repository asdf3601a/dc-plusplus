module.exports = {
    apps: [{
        name: 'VoiceLog',
        script: './dist',
        // Options reference: https://pm2.keymetrics.io/docs/usage/application-declaration/
        // args: 'one two',
        instances: 1,
        autorestart: true,
        // The bot exits with 78 when it needs you before it can run: its data check failed (run `pnpm migrate`), or config.json was just created, migrated or is newer than this build (check it, then start the bot yourself). Restarting would only repeat that
        stop_exit_codes: [78],
        watch: false,
        max_memory_restart: '512M',
        env_production: {
            NODE_ENV: 'production'
        }
    }],

    deploy: {
        production: {
            user: 'node',
            ref: 'origin/master',
            repo: 'https://github.com/jimchen5209/Discord-Voice-log.git',
            path: '/var/www/production',
            'post-deploy': 'pnpm install && pnpm build && pnpm migrate && pm2 reload ecosystem.config.js --env production'
        }
    }
};
