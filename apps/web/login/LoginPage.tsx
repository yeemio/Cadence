/**
 * 登录页（MPA 独立入口，收尾波-③ 真实化）：用户名 + 口令表单 →
 * POST /auth/login（authTransport 直连，不加载 refine/router——登录 bundle
 * 最小化前提不变）。成功写入 token 会话存储后整页跳转主壳。
 *
 * 演示文案（DEMO_IDENTITIES 提示的延续）：种子演示身份改由服务端种子提供
 * （prisma/seed.mjs：admin / viewer / approver / demo-admin，默认口令
 * demo-password）；页面脚注列出演示账号，占位符同步。
 */
import { useState, type FormEvent } from 'react';
import { AudioWaveform } from 'lucide-react';
import { createBrowserTokenSessionStore, toTokenSession } from '@smes/product-ui';
import { authTransport } from '../src/data/authApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const sessionStore = createBrowserTokenSessionStore(window.localStorage);

/** 种子演示账号（与 prisma/seed.mjs 一致；默认口令 demo-password）。 */
const DEMO_ACCOUNTS = 'admin（管理员）/ viewer（只读访客）/ approver（审批人）';

export function LoginPage() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = await authTransport.login(username.trim(), password);
      sessionStore.write(toTokenSession(payload));
      // MPA 跳转：整页加载主壳入口，登录 bundle 生命周期到此为止
      window.location.assign('/');
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : '登录失败，请稍后重试',
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-muted/40 px-4">
      <div className="flex flex-col items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <AudioWaveform className="size-5" />
        </div>
        <div className="text-center">
          <h1 className="text-lg font-semibold tracking-tight">Cadence</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">离散制造运营平台 · 演示环境</p>
        </div>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>登录</CardTitle>
          <CardDescription>使用账号进入主应用</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="login-username">用户名</Label>
              <Input
                id="login-username"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                placeholder="admin"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="login-password">口令</Label>
              <Input
                id="login-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="demo-password"
              />
            </div>
            {error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" className="w-full" disabled={submitting}>
              {submitting ? '登录中…' : '登录'}
            </Button>
          </form>
          <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
            演示账号：{DEMO_ACCOUNTS}，默认口令 demo-password（种子演示环境，非生产凭据）。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
