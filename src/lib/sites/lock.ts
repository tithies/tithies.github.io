/**
 * One Moxfield (or other site) job at a time: the deck sync and an export share the site's tab,
 * its pace, and the account's data (an export changes what a sync reads). Each job takes the
 * site's lock for its whole run.
 */
export class SiteLock {
  private holder: string | null = null;

  /** Who holds it ('sync', 'export', …), or null. */
  get heldBy(): string | null {
    return this.holder;
  }

  /** Takes it unless someone else holds it (taking it again as the holder is fine). */
  tryAcquire(who: string): boolean {
    if (this.holder !== null && this.holder !== who) return false;
    this.holder = who;
    return true;
  }

  release(who: string): void {
    if (this.holder === who) this.holder = null;
  }
}
