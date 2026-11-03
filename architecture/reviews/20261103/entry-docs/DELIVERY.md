# PR #6 — F9 根入口说明修复

作者：本普通 Chat。2026-11-03。父提交
`213580cedbfa7f2991746dff38dfbff2dd85769d`；审查基线
`5425feb93856772c728ffb482b18bced5eb88558`。本文件所在提交为候选；准确
commit/tree/逐文件 SHA256 由冻结回执提供。

## 变化与范围

- `README.md` 当前阶段改为 2026-10-31 M2 按范围整体接受、18 文件已由准确 SHA
  封存、真实客户/M3 未启动。说明原 PM“尚未提交”对应原裁决时点；保留 IAB PDF、
  真实历史/图纸、D-18/O5 等边界及原共享 19 项历史分布。旧 S3 记录继续保留。
- `START-HERE.md` 先列产品合同、生命周期、路线图和决策队列的当前入口，再列六个
  已授权分类 PR、单作者/总控职责及权限边界。旧 lane/m4-final 全文保留并标历史，
  不再作为当前授权。不把尚未合入的 PR 修复描述成 main 已完成。
- 本目录 `TASK.md` 同步 Owner 批次授权，`DELIVERY.md` 记录验证。

没有修改 PM 三份事实源、产品/Compose/依赖字节；没有新增测试套件或客户范围。

## 实际检查

在本分支工作树执行一次性 Python 检查 README/START-HERE Markdown 链接：
跳过外部 HTTP/mailto；本地目标必须存在，指定锚点须匹配显式 HTML anchor 或标题。
实际退出码 0，输出：

```text
Local links/anchors checked: 11
PASS: all local link targets and requested anchors exist
```

可直接复核的命令（仓库根目录）：

```bash
python - <<'PY'
from pathlib import Path
import re
from urllib.parse import unquote
root=Path.cwd(); count=0; failures=[]
for name in ('README.md','START-HERE.md'):
    for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', (root/name).read_text()):
        if re.match(r'^(https?:|mailto:)', target): continue
        path, _, anchor=target.partition('#')
        dest=root/path if path else root/name
        count+=1
        if not dest.exists(): failures.append(f'{name}: missing {target}'); continue
        if anchor:
            content=dest.read_text()
            explicit=set(re.findall(r'<a\s+(?:id|name)=["\']([^"\']+)',content))
            headings={re.sub(r'[^\w\- ]','',h.lower()).replace(' ','-') for h in re.findall(r'^#+\s+(.+)$',content,re.M)}
            if unquote(anchor) not in explicit|headings: failures.append(f'{name}: missing anchor {target}')
print(f'Local links/anchors checked: {count}')
print('\n'.join(failures) if failures else 'PASS: all local link targets and requested anchors exist')
raise SystemExit(bool(failures))
PY
git diff --check
```

`git diff --check` 退出码 0。人工核对当前段落与已给定封存/接受事实，旧记录保留。
仅文档修改，未运行 build、全仓 verify、业务测试或真实环境验收；外部 PR 页面可用性
不由本地链接检查证明。其它 PR 的检查不能算成本 PR 的运行结果。

## 发布边界

GitHub 集成既有 403 `Resource not accessible by integration` 未重试。
`BLOCKED_DELIVERY_PUBLICATION`：由总控机械发布至既有分支
`codex/chat-review-entry-docs-20261103`；不新开 PR、不写 main、不 merge/deploy。
准确本地 commit/tree 和全量补丁另以聊天正文交付，非远端已发布声明。
