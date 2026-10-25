/**
 * 用户管理页（M1 增量 3-D）：用户列表 + 创建，数据走真实 org API。
 * 角色授予在角色页与用户行内完成（本页保持最小集：列表 + 创建）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { createOrgUser, listOrgUsers, OrgApiError } from '../../data/orgApi';
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

export function OrgUsersPage() {
  const queryClient = useQueryClient();
  const usersQuery = useQuery({ queryKey: ['org', 'users'], queryFn: listOrgUsers });
  const createMutation = useMutation({
    mutationFn: createOrgUser,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['org', 'users'] }),
  });

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate({ username, displayName }, { onSuccess: () => {
      setUsername('');
      setDisplayName('');
    } });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>用户列表</CardTitle>
          <CardDescription>当前租户内的用户元数据（真实 org API 读回）。</CardDescription>
        </CardHeader>
        <CardContent>
          {usersQuery.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> 正在加载…
            </p>
          )}
          {usersQuery.isError && (
            <ApiErrorHint error={usersQuery.error} />
          )}
          {usersQuery.data !== undefined && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">id</th>
                  <th className="py-2 pr-4 font-medium">用户名</th>
                  <th className="py-2 pr-4 font-medium">显示名</th>
                  <th className="py-2 font-medium">启用</th>
                </tr>
              </thead>
              <tbody>
                {usersQuery.data.map((user) => (
                  <tr key={user.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 font-mono text-xs">{user.id}</td>
                    <td className="py-2 pr-4 font-mono">{user.username}</td>
                    <td className="py-2 pr-4">{user.displayName}</td>
                    <td className="py-2">{user.active ? '是' : '否'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>创建用户</CardTitle>
          <CardDescription>用户名为小写字母/数字/连字符；租户内唯一（冲突 409）。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="org-user-username">用户名</Label>
              <Input
                id="org-user-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="wang"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="org-user-display">显示名</Label>
              <Input
                id="org-user-display"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="王工"
                required
              />
            </div>
            {createMutation.isError && <ApiErrorHint error={createMutation.error} />}
            <Button type="submit" disabled={createMutation.isPending || username.length === 0 || displayName.length === 0}>
              创建用户
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/** 服务端拒绝的统一提示（403 = 会话身份在服务端无对应策略；400/409 = 业务校验）。 */
export function ApiErrorHint({ error }: { error: unknown }) {
  const status = error instanceof OrgApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="text-sm text-destructive">
      {status === 403
        ? `服务端拒绝（403）：当前会话身份未获授权——需管理员在服务端为其授予策略。${message}`
        : `请求失败${status === undefined ? '' : `（${status}）`}：${message}`}
    </p>
  );
}
