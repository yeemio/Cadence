/**
 * 登录 MPA 独立入口（ADR-0009 参照：登录最小 bundle，不加载主应用/refine/router）。
 * 收尾波-③ 起依赖 @smes/product-ui 的 token 会话原语 + authTransport（纯 fetch）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LoginPage } from './LoginPage';
import '../src/index.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <LoginPage />
  </StrictMode>,
);
