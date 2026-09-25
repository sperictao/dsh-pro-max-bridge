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
实测（2026-09-25）：该界面**接受 tarball URL**，直接粘上面这条即可，之后 DSH Pro Max 自己能管它。
