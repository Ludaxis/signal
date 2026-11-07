// The Suno site binding. Configuration only.
//
// Suno's terms bar robots, scraping and similar automated methods and circumvention of blocking, and there is no
// public API. So this binding ships not allowed, with no run button, whatever any switch or setting says. Opening it
// needs a written decision about the site's terms and a reviewed code change, not a setting.
// Meanwhile the owner makes tracks in Suno by hand and drops them on the music step (owner-upload).
import { t } from '@/app/studio/copy/en';
import type { BrowserTask } from '../driver';

export interface SiteBinding {
  siteId: string;
  title: string;
  origins: string[];
  /** false = the binding can never run live in this release (state not-allowed, invoke 403). */
  allowed: boolean;
  line: string;
  reason: string;
  /** The fixed goal template; inputs are filled as data. */
  goal: string;
  forbidden: string[];
  expectDownloads: BrowserTask['expectDownloads'];
  /** Selector of the credits / plan indicator captured before and after (rule 3), when known. */
  creditsSelector: string | null;
}

export const suno: SiteBinding = {
  siteId: 'suno',
  title: 'Suno',
  origins: ['https://suno.com'],
  allowed: false,
  line: t('connector.notAllowedSite'),
  reason: 'The site’s terms do not allow automated use.',
  goal: 'Make one instrumental track with the style and length in the task inputs, then download the two versions as audio files.',
  forbidden: ['delete song', 'make public', 'remix', 'buy', 'top up'],
  expectDownloads: { mime: 'audio/*', count: 2, maxBytes: 50 * 1024 * 1024 },
  creditsSelector: null,
};

export const SITE_BINDINGS: readonly SiteBinding[] = [suno];
export const siteBinding = (id: string) => SITE_BINDINGS.find((s) => s.siteId === id) ?? null;
