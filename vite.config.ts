import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const repoBase = process.env.GITHUB_PAGES ? '/im-starving/' : './';

// https://vite.dev/config/
export default defineConfig({
  base: repoBase,
  plugins: [react()],
})
