# Logi MX Master 4：剪辑助手 Actions Ring

Actions Ring 按键清单见 [`configs/logi-mx-master-4-actions-ring.json`](../configs/logi-mx-master-4-actions-ring.json)。剪辑助手新增的按键只在本软件窗口响应，不注册为 Windows 全局快捷键。

## 快捷键

| Actions Ring 名称 | 按键 | 功能 |
| --- | --- | --- |
| 打开下载区域 | `Ctrl+Alt+1` | 切换到下载区域 |
| 打开剪辑区域 | `Ctrl+Alt+2` | 切换到剪辑区域 |
| 匹配文案／校对 | `Ctrl+Alt+M` | 在剪辑区域运行文案匹配，标记口播与正确文案的差异 |
| 打开导出设置 | `Ctrl+Alt+E` | 打开导出视频设置；确认设置后才会开始导出 |
| 时间线放大 | `Ctrl+=` | 以播放头为中心放大时间线 |
| 时间线缩小 | `Ctrl+-` | 以播放头为中心缩小时间线 |
| 时间线适合视图 | `Ctrl+0` 或 `Shift+Z` | 缩放时间线以适合视图 |

“匹配文案／校对”会分析口播和正确文案并标出差异，不会自动改写正确文案。时间线缩放快捷键在剪辑区域生效。导出快捷键只打开设置窗口，不会跳过确认直接导出。

## 在 Logi Options+ 中配置

1. 打开 Actions Ring 的“剪辑助手”应用配置。
2. 把每个气泡设置为键盘按键动作，并按上表录入对应组合。
3. 把 MX Master 4 的 Haptic Sense Panel 映射为 **Show Actions Ring**。
4. 在 MX Master 4 的 **Haptic feedback** 设置中启用 Actions Ring 触觉反馈；强度建议从 **Medium** 开始。

这份 JSON 是录入清单，不是 Logi Options+ 可直接导入的配置包。应用快捷键需要运行包含本次更新的剪辑助手版本。

## 官方参考

- [Logitech：Actions Ring 设置与应用配置](https://support.logi.com/hc/en-us/articles/17844647906967-Logi-Options-Actions-Ring)
- [Logitech：MX Master 4 触觉反馈](https://support.logi.com/hc/en-gb/articles/40581588219671-MX-Master-4-Native-Haptics-with-Windows-11)
