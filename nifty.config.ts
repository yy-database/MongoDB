// Nifty project configuration for MongoDB (hybrid cargo + pnpm).
import { defineConfig } from '@doki-land/nifty';

export default defineConfig({
    trust: {
        npm: {
            repo: 'yy-database/MongoDB',
            file: 'publish-npm.yml',
            environment: 'NPM_PUBLISH',
        },
    },
});
