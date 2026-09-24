# dsh-pro-max-bridge

把 **DeepSeek Harness 桌面应用自己的** Plugin Manager 与 Config Editor 开放给
[DSH Pro Max](https://github.com/sperictao/dsh-pro-max) 的桥接插件。

## 为什么需要它

dsh 的 `desktop` 运行档由官方 Electron 应用独占：CLI 对启动、`--dump-config`、
`plugin` 一律按名字拒绝（`profile "desktop" is managed exclusively by the Electron
application`）。所以管理这个档的插件与配置只有两条路——在应用背后直写
`~/.dsh/profiles/desktop`，或者成为它加载的一个插件。

本插件走第二条：调用应用**自己的**服务，是同一个机制、不是第二份实现。直写那条路
被否决还有一个硬理由：安装护栏最关键的一道 `--dump-config` 组合预检对 desktop 物理
不可执行。完整决策记录见 dsh-pro-max 仓库的 `docs/adr/0011`。

## 安装（一次性手工步骤）

在桌面应用里粘一次本插件的 tgz 地址：

```
https://github.com/sperictao/dsh-pro-max-bridge/releases/latest/download/dsh-pro-max-bridge.tgz
```

这个地址永远指向最新一个 Release（靠 GitHub 的 `latest` 重定向），所以升级桥接也是粘同一条。
应用到插件目录后即可，之后 DSH Pro Max 自己能管它。

> 为什么不让 DSH Pro Max 代装：它没有进入应用插件安装流程的入口；代装只能靠直写
> profile，而那正是本插件存在要避免的事。

## token

插件首次激活时生成一个 32 字节随机 token 写到 `~/.dsh-pro-max/bridge-token`
（0600），DSH Pro Max 读同一份。**它是纵深防御而不是安全边界**：同用户的本地进程
本就能直写那个 profile，token 挡的是浏览器页面之类对本机回环端口的越权调用。

## 线协议

路由一律在 `/dsh-pro-max-bridge/*`，即 `/api` 之外——`/api` 前缀由连接插件按
capability 裁决，本插件不参与那套授权。应答是 `{ok: true, data}` 或
`{ok: false, error}`；HTTP 状态码只表达传输层语义（401 未授权 / 405 方法不符 /
500 处理失败），**业务结果在 body 里**。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/ping` | 免 token。返回 `{bridge, protocol}`：DSH Pro Max 用它判断桥接在不在、是否同代 |
| `GET` | `/plugins` | `{plugins, bundles}` |
| `POST` | `/plugins/install` | `{spec, requestId?, enabled?, approvedBuilds?}` → `ChangeResult` |
| `POST` | `/plugins/remove` | `{name}` → `ChangeResult` |
| `POST` | `/plugins/enable` | `{pluginId?, bundleName?, enabled}` → `ChangeResult` |
| `GET` | `/config` | 活动 profile 各行配置（`id` / `name` / `current` / `inherited` / `override`） |
| `POST` | `/config/edit` | `{id, config}` → 写入该行的绝对 `config` |

`ChangeResult` 是上游的类型：`pluginManager` 的写操作把管理失败**折叠进返回值**而不是
抛出，所以调用方要看 `data.application`（`applied` / `restart-required` /
`overridden` / `failed` / `cancelled`）而不是状态码。

`protocol` 在路由形状或字段语义变化时 +1。DSH Pro Max 见到不认识的 protocol 会提示
升级桥接，而不是把字段缺失当成应用故障。

## 三条硬约束（上游行为，不是本插件的偏好）

- **只增路由，不接管 `connection`**：桌面 shell 启动时要向宿主根路径要一次
  `303 + set-cookie` 换取 host cookie，替换 connection 会让这条握手失败并直接进崩溃
  恢复。
- **永不产生未处理异常**：未捕获异常会触发应用的崩溃恢复，那条路径重置 bundle 列表
  并禁用第三方插件（而普通的激活失败只是被隔离，应用照常运行）。故每个路由的 handler
  整体兜底，宁可回一条 500。
- **只 inject `webServer`**：另外两个服务若缺席，路由给出原因，而不是让插件整体不
  激活——那样 DSH Pro Max 会把「已装但服务缺失」误报成「未安装桥接」。

## 开发

```sh
pnpm install
pnpm run check   # typecheck + test + build
pnpm run pack    # dist/dsh-pro-max-bridge.tgz（资产名不含版本号，见 scripts/pack.mjs）
```

发布：版本号 bump 后打 `v<version>` tag 并推送，CI 校验 tag 与 `package.json` 版本
一致、跑 `check`、打 tgz 并挂到 Release。

`tests/bridge.test.ts` 用一个替身 ctx 驱动真实 handler，覆盖路由、鉴权、
序列化（活的 Loader `Entry` 带循环引用，过不了 JSON）与兜底。真机只剩「应用自己的
服务确实按这个形状应答」这一件事。
