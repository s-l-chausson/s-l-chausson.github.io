// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://s-l-chausson.github.io',
  output: 'static',
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()]
  }
});