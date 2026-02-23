import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            './ai-service': path.resolve(__dirname, 'src/ai-service.js'),
        },
    },
});
