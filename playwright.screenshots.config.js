// README screenshots only (`npm run screenshots`): the e2e config with its own test directory.
import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

export default defineConfig({ ...base, testDir: 'test/screenshots' });
