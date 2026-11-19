# 第三方许可声明（Third-Party Notices）

本项目（`antigravity-zh-patch`）代码与自带分发词典遵循 MIT 许可证（见 [LICENSE](./LICENSE)）。

## 1. yiheng8023/antigravity-chinese

- **项目地址**：`https://github.com/yiheng8023/antigravity-chinese`
- **使用范围**：默认分发包中的 `dicts/00_community_zh.json` 词条与 `dicts/regex_rules.json` 社区动态规则源自其 `dict/zh-CN.json`，经结构化筛选（仅保留静态映射与严格首尾锚定正则）及排版清洗后随包提供。
- **许可证原文**：

```text
MIT License

Copyright (c) 2026 Antigravity Chinese Localization Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. 可选本地补充词库来源说明

`cli.mjs update-dicts --all-sources` 提供可选的个人本地词库扩充模式，从 `qqxpee/antigravity2-cn` 与 `Silas-02/antigravity-desktop-cn` 拉取补充词条并与 MIT 词库在本地合并（重叠时优先保留 MIT 词条）。由于上述可选补充仓库未附带明确的开源分发许可证，该模式默认仅写入用户本机的 `%USERPROFILE%\.antigravity-zh\dicts\`，**不会**写入本仓库或任何对外分发压缩包中。
