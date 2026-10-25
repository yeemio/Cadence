/**
 * 角色与授权页（M1 增量 3-D）：角色列表 + 创建 + 期望态权限授权，
 * 数据走真实 org API（PUT 全量期望集，服务端 diff 授权）。
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { createOrgRole, listOrgRoles, setOrgRolePermissions } from '../../data/orgApi';
import { ApiErrorHint } from './OrgUsersPage';
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

export function OrgRolesPage() {
  const queryClient = useQueryClient();
  const rolesQuery = useQuery({ queryKey: ['org', 'roles'], queryFn: listOrgRoles });
  const invalidate = (): void => {
    queryClient.invalidateQueries({ queryKey: ['org', 'roles'] });
  };
  const createMutation = useMutation({ mutationFn: createOrgRole, onSuccess: invalidate });
  const grantMutation = useMutation({
    mutationFn: ({ name, codes }: { name: string; codes: string[] }) =>
      setOrgRolePermissions(name, codes),
    onSuccess: invalidate,
  });

  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate({ name, displayName }, {
      onSuccess: () => {
        setName('');
        setDisplayName('');
      },
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>角色与授权</CardTitle>
          <CardDescription>
            每行提交一次全量期望权限集（逗号分隔，如 <code className="font-mono text-xs">demo:read, demo:write</code>）；服务端按差集授予/撤销。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rolesQuery.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> 正在加载…
            </p>
          )}
          {rolesQuery.isError && <ApiErrorHint error={rolesQuery.error} />}
          <div className="flex flex-col gap-4">
            {rolesQuery.data?.map((role) => (
              <RoleRow
                key={role.name}
                name={role.name}
                displayName={role.displayName}
                permissions={role.permissions}
                saving={grantMutation.isPending && grantMutation.variables?.name === role.name}
                error={
                  grantMutation.isError && grantMutation.variables?.name === role.name
                    ? grantMutation.error
                    : null
                }
                onSave={(codes) => grantMutation.mutate({ name: role.name, codes })}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>创建角色</CardTitle>
          <CardDescription>角色名为单段小写形状（小写字母/数字/连字符）；租户内唯一。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="org-role-name">角色名</Label>
              <Input
                id="org-role-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="planner"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="org-role-display">显示名</Label>
              <Input
                id="org-role-display"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="计划员"
                required
              />
            </div>
            {createMutation.isError && <ApiErrorHint error={createMutation.error} />}
            <Button
              type="submit"
              disabled={createMutation.isPending || name.length === 0 || displayName.length === 0}
            >
              创建角色
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function RoleRow({
  name,
  displayName,
  permissions,
  saving,
  error,
  onSave,
}: {
  readonly name: string;
  readonly displayName: string;
  readonly permissions: readonly string[];
  readonly saving: boolean;
  readonly error: unknown;
  readonly onSave: (codes: string[]) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? permissions.join(', ');

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <span className="font-mono text-sm font-medium">{name}</span>
          <span className="ml-2 text-sm text-muted-foreground">{displayName}</span>
        </div>
        <span className="text-xs text-muted-foreground">{permissions.length} 项权限</span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label={`角色 ${name} 的权限码集合`}
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="demo:read, demo:write"
          className="font-mono text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={saving || draft === null}
          onClick={() => {
            onSave(draft?.split(',').map((code) => code.trim()) ?? []);
            setDraft(null);
          }}
        >
          {saving ? '保存中…' : '保存授权'}
        </Button>
      </div>
      {error !== null && <ApiErrorHint error={error} />}
    </div>
  );
}
