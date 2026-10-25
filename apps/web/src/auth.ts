/**
 * authProvider 装配（收尾波-③ 真实化）：token 会话 + 后端 /auth/* 传输层。
 * 登录 MPA 入口（login/）写同一存储键——两个独立 bundle 之间只共享存储，
 * 不共享运行时（ADR-0009 隔离前提不变）。
 */
import {
  createBrowserTokenSessionStore,
  createTokenAuthProvider,
} from '@smes/product-ui';
import { authTransport } from './data/authApi';

/** 浏览器 token 会话存储（主壳与登录 bundle 同键共享的单例语义）。 */
export const browserTokenSessionStore = createBrowserTokenSessionStore(window.localStorage);

export function createAuthProvider() {
  return createTokenAuthProvider({
    transport: authTransport,
    store: browserTokenSessionStore,
    loginPath: '/login',
    homePath: '/',
  });
}
