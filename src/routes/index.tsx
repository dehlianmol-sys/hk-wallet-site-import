import { createFileRoute } from '@tanstack/react-router';
import App from '../App';

export const Route = createFileRoute('/')({
  ssr: false,
  head: () => ({
    meta: [
      { title: 'HK Wallet — Earn Money Online' },
      { name: 'description', content: 'Download HK Wallet, complete simple tasks, and manage UPI payments and rewards.' },
      { property: 'og:title', content: 'HK Wallet — Earn Money Online' },
      { property: 'og:description', content: 'Download HK Wallet, complete simple tasks, and manage UPI payments and rewards.' },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
  component: App,
});
