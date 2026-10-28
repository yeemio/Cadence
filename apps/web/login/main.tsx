/**
 * 登录 MPA 独立入口（ADR-0009 参照：登录最小 bundle，不加载主应用/refine/router）。
 * 收尾波-③ 起依赖 @smes/product-ui 的 token 会话原语 + authTransport（纯 fetch）。
 *
 * i18n 波 1（ADR-0012）：登录入口只挂 login+common 两 namespace——menu 等
 * 主壳 namespace 不进登录 bundle 加载图（locale 文件按 namespace 惰性分块）。
 * init 完成后再渲染（内联资源就绪，无 key 闪烁）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '../src/i18n';
import { LoginPage } from './LoginPage';
import '../src/index.css';

await initI18n(['login', 'common']);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <LoginPage />
  </StrictMode>,
);
