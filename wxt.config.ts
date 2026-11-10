import { defineConfig } from 'wxt';
import { RELEASE_PAGE_URL } from './src/lib/release-url';
// @ts-expect-error plain ESM helper shared with scripts/build-site.mjs (no type declarations)
import { extensionVersion } from './scripts/version.mjs';

/**
 * Public half of the extension's signing key. It fixes the extension ID to
 * cihnokdnhnhjamllchdmnehblkekcjbj wherever the unpacked folder lives, so updating by unzipping
 * a new version anywhere keeps the user's data (IndexedDB and storage belong to the ID).
 * The private key is kept outside the repo; it's only needed to pack a .crx or publish to a store.
 */
const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAva1YoGlk4BU8vu65MXXO55TNg7adY7o5vjkx6a3E4qXeplQpu7RXCoykHDlAtK3YlDyKniNcCtgqlcMc1PObkkMrbWUdJTcNu0VzZ+7bsrQi9SIVX1h6M9MsfE/alyMu167ApIO9QBGxqSs2xBo6QqW5/GN3PpkE9Y5P4dQOYhtuL00mtvRgWTR5VpZib+ITLnVQfcn4JVI7oUmYzCObTGHDPGzqd+1TIz38aujV139ynHwvN5AFYv+b4yUkXjiKMqi+c9yEza0ZHho4cezWiPXPsBbPUXDg6LNV3p/YUHFEj3tHKfVPaxUbvITm04rsz7I4ipGiWD/T4ymnoTtOIQIDAQAB';

export default defineConfig({
  srcDir: 'src',
  // Fixed zip name: WXT's {{version}} is package.json's, not the computed manifest version.
  zip: { artifactTemplate: '{{name}}-{{browser}}.zip' },
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Tithies',
    // Automatic: <major.minor from package.json>.<commits that changed the extension>.
    version: extensionVersion(),
    description: 'Moxfield + Face to Face Games tools: check which of your cards F2F buys, and find mismatches between your decks and collection.',
    permissions: ['storage', 'unlimitedStorage', 'alarms'],
    // moxfield.com: lets the background find logged-in Moxfield tabs (tabs.query url filter); the content scripts already run there.
    host_permissions: ['https://facetofacegames.com/*', 'https://api2.moxfield.com/*', 'https://moxfield.com/*', 'https://www.moxfield.com/*'],
    action: { default_title: 'Open Tithies dashboard' },
    homepage_url: RELEASE_PAGE_URL,
    key: EXTENSION_KEY,
  },
});
