import type { Metadata } from 'next';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/fraunces/400-italic.css';
import './studio-tokens.css';
import './fonts.css';
import './studio.css';
import './ui/ui.css';
import './plan-setup.css';
import './work.css';
import './postmaker.css';
import { featureEnabled } from '@/lib/server/signalConfig';
import { Studio } from './Studio';

export const metadata: Metadata = { title: 'Content Studio' };
// The `postmaker` feature switch is read per request (it can change while Signal runs), so the page is dynamic.
export const dynamic = 'force-dynamic';

export default async function StudioPage() {
  // Post maker shows (nav tab, screens, Today rows) only while its feature switch is on.
  return <Studio postmaker={await featureEnabled('postmaker')} />;
}
