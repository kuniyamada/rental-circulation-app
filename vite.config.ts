import build from '@hono/vite-build/cloudflare-pages'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    build(),
    devServer({
      adapter,
      entry: 'src/index.tsx'
    })
  ],
  build: {
    rollupOptions: {
      // child_process は sendmail トランスポートでのみ使用されるため外部化
      // SMTP トランスポート使用時は実際には呼ばれない
      external: ['child_process'],
    }
  }
})
