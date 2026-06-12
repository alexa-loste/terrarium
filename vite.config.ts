import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  // We host at the ROOT of terrarium-society.netlify.app, so assets must resolve at '/'.
  // (Upstream AI-Town used base '/ai-town' to deploy under a subpath — that 404'd our assets
  // and shipped a blank page.)
  base: '/',
  plugins: [react()],
  server: {
    allowedHosts: ['ai-town-your-app-name.fly.dev', 'localhost', '127.0.0.1'],
  },
});
