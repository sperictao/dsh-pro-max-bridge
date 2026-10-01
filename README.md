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

在桌面应用的 Plugins 页粘一次 DSH Pro Max 界面上显示的安装串，形如：

```
@sperictao/dsh-pro-max-bridge@0.1.5
```

版本号由 DSH Pro Max 钉住：它给出的永远是自己测过、协议代次对得上的那一版，升级桥接也是粘它新给的那条。

### 为什么走 npm registry、而且钉精确版本

桌面应用内嵌的 pnpm（0.2.0-rc.2 时仍是 11.7.0）对**远程 tarball 地址**有缺陷：该地址的包已在本机
store 里时，它复用缓存而不下载，写出的 lockfile 条目缺 `integrity`，随即又被自己的供应链检查拒掉
（`ERR_PNPM_MISSING_TARBALL_INTEGRITY`）——卸载后重装同一地址必然复现，且每次重试都一样。registry
包的 integrity 来自 registry 元数据，不受此影响。

钉精确版本是因为 pnpm 11 默认拦截发布不满 24 小时的版本：精确版本照装，dist-tag 与范围则会
**静默解析到更旧的版本**而报成功。

### 从旧安装迁移

旧版本以 `@dsh-external/dsh-pro-max-bridge`（tarball 地址）安装。包名不同，两者会注册同一组路由，
所以**先在 Plugins 页移除旧的那个**，再粘新的安装串。
