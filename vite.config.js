import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/eapi': {
        target: 'https://eapi.binance.com',
        changeOrigin: true,
      }
    }
  }
});
