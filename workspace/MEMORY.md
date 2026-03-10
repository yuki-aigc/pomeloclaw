# 长期记忆

> 此文件存储重要的持久性信息，如用户偏好、重要决策和持久性事实。

---


[10:31:35] ## 用户规则（2025-01-09）

### 查询数据时优先确认系统时间
- **要求**：在查询任何数据之前，必须先查看系统时间确认当前日期
- **原因**：避免基于文件名或推测的错误日期进行查询
- **正确做法**：
  1. 先执行 `date` 或相关命令获取系统时间
  2. 确认后再进行数据查询
  3. 不应基于记忆文件名假设当前日期


[16:35:32] 用户偏好：涉及联网搜索时，直接使用 web-search__bailian_web_search MCP 工具。

[14:03:50] ## PDF 转换最佳实践（中文文档）

**场景**: 将 Markdown 报告转换为 PDF 格式

**问题**: pandoc 默认 LaTeX 引擎不支持中文字符，会报错 `Unicode character 成 (U+6210) not set up for use with LaTeX`

**解决方案**: 使用 xelatex 引擎配合中文字体
```bash
pandoc input.md -o output.pdf --pdf-engine=xelatex -V CJKmainfont="Noto Sans CJK SC"
```

**注意事项**:
- 转换成功时可能会有 emoji 字符缺失警告（如 🟢🟡🔴），不影响中文内容
- 警告示例：`Missing character: There is no 🟢 (U+1F7E2) in font`
- 可忽略这些警告，PDF 主体内容完整

**备选方案**: 如 xelatex 不可用，可转为 HTML 后在浏览器中打印为 PDF
```bash
pandoc input.md -o output.html --standalone
```
