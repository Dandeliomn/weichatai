import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // API 调用 → Docker nginx（所有 api.get() 都有 baseURL: '/api'）
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/webhook': { target: 'http://localhost:8080', changeOrigin: true },
      // 静态资源 → weixin-bridge / MinIO
      '/qr': { target: 'http://localhost:8080', changeOrigin: true },
      '/qr.svg': { target: 'http://localhost:8080', changeOrigin: true },
      '/qr.txt': { target: 'http://localhost:8080', changeOrigin: true },
      '/stats': { target: 'http://localhost:8080', changeOrigin: true },
      '/openilink': { target: 'http://localhost:8080', changeOrigin: true },
      // 注意: 不要代理 '/bridge'！这是 React Router SPA 路由
      // API 路径已通过 '/api' 前缀处理
    },
  },
});
