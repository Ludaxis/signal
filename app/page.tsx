import { redirect } from 'next/navigation';

// The Content Studio is the landing page.
export default function Home() {
  redirect('/studio');
}
