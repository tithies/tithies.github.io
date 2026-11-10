import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Tithies',
    description: 'Moxfield + Face to Face Games tools: check which of your cards F2F buys, and find mismatches between your decks and collection.',
    permissions: ['storage', 'unlimitedStorage', 'alarms'],
    // moxfield.com: lets the background find logged-in Moxfield tabs (tabs.query url filter); the content scripts already run there.
    host_permissions: ['https://facetofacegames.com/*', 'https://api2.moxfield.com/*', 'https://moxfield.com/*', 'https://www.moxfield.com/*'],
    action: { default_title: 'Open Tithies dashboard' },
  },
});
