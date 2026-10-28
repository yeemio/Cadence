/**
 * 登录页（MPA 独立入口，收尾波-③ 真实化）：用户名 + 口令表单 →
 * POST /auth/login（authTransport 直连，不加载 refine/router——登录 bundle
 * 最小化前提不变）。成功写入 token 会话存储后整页跳转主壳。
 *
 * 演示文案（DEMO_IDENTITIES 提示的延续）：种子演示身份改由服务端种子提供
 * （prisma/seed.mjs：admin / viewer / approver / demo-admin，默认口令
 * demo-password）；页面脚注列出演示账号，占位符同步。
 *
 * i18n 波 1（ADR-0012）：文案走 login namespace t()；右上角挂语言切换器
 * （登录前无会话，localStorage `smes.locale` 是双入口唯一共享点——proposal §7）。
 */
import { useState, type FormEvent } from 'react';
import { AudioWaveform } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
import { LanguageSwitch } from '../src/i18n/LanguageSwitch';

const sessionStore = createBrowserTokenSessionStore(window.localStorage);

/** 种子演示账号默认口令（与 prisma/seed.mjs 一致）。 */
const DEMO_DEFAULT_PASSWORD = 'demo-password';

export function LoginPage() {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
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
      // 后端 message（中文原文）原样回显，仅空消息兜底走 t()（波 2 错误码映射再覆盖）
      setError(
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : t('login:error.fallback'),
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-muted/40 px-4">
      <div className="fixed top-3 right-3 z-10">
        <LanguageSwitch />
      </div>
      <div className="flex flex-col items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <AudioWaveform className="size-5" />
        </div>
        <div className="text-center">
          <h1 className="text-lg font-semibold tracking-tight">Cadence</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('common:brand.subtitleFull')}</p>
        </div>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('login:form.title')}</CardTitle>
          <CardDescription>{t('login:form.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="login-username">{t('login:form.username')}</Label>
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
              <Label htmlFor="login-password">{t('login:form.password')}</Label>
              <Input
                id="login-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder={DEMO_DEFAULT_PASSWORD}
              />
            </div>
            {error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" className="w-full" disabled={submitting}>
              {submitting ? t('login:action.signingIn') : t('login:action.signIn')}
            </Button>
          </form>
          <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
            {t('login:demo.notice', {
              accounts: t('login:demo.accounts'),
              password: DEMO_DEFAULT_PASSWORD,
            })}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
