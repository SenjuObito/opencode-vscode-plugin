/**
 * 独立预览入口：在纯浏览器（无 JCEF 桥）中渲染使用统计仪表盘。
 * 用法：`npm run dev` 后访问 http://localhost:5173/tt-preview.html
 * 数据经 vite `/tt-dev` 代理转发到本机 127.0.0.1:7680 的 tokentracker 服务。
 * 加 `?theme=dark` / `?theme=light` 可固定主题（写入 documentElement data-theme）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/app.less';
import './i18n/config';
import { UsageDashboardSection } from './components/UsageStatistics/UsageDashboardSection';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme');
if (theme === 'dark' || theme === 'light') {
  document.documentElement.setAttribute('data-theme', theme);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <UsageDashboardSection />
    </div>
  </StrictMode>,
);
