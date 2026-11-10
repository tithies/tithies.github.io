/**
 * Where Tithies is published (GitHub Pages, built by .github/workflows/pages.yml): the download
 * page, the zip and `version.json`. The repo is github.com/tithies/tithies.github.io (an
 * organization site), so the page is at the domain root. Installed copies keep checking the
 * address they were built with: change it only together with a redirect. No imports:
 * wxt.config.ts uses it too.
 */
export const RELEASE_PAGE_URL = 'https://tithies.github.io/';
export const RELEASE_VERSION_URL = `${RELEASE_PAGE_URL}version.json`;
