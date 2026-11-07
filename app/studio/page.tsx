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
import { Studio } from './Studio';

export const metadata: Metadata = { title: 'Content Studio' };

export default function StudioPage() {
  return <Studio />;
}
