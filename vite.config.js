import { defineConfig } from 'vite';

export default defineConfig({
  base: '/paper_trading_software/',
  server: {
    proxy: {
      '/eapi': {
        target: 'https://eapi.binance.com',
        changeOrigin: true,
      }
    }
  }
});
