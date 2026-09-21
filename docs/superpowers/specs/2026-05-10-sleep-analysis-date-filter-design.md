---
name: sleep-analysis-date-filter
description: 为睡眠分析弹窗添加日期筛选功能
type: project
---

# 睡眠分析日期筛选功能

## 概述

在睡眠分析弹窗中新增日期选择器，默认选中当前日期，点击展开日历组件，可切换不同日期查看该日睡眠数据。

## 需求

1. 日期按钮默认显示"今天"（当前日期）
2. 点击日期按钮展开/收起日历
3. 日历支持月份切换
4. 点击日期切换展示该日期睡眠数据
5. 提供"今天"快捷按钮

## 实现方案

### 前端修改 (templates/index.html)

**日期选择器 HTML**
- 在 `sleep-analysis-modal` 的 `modal-body` 区域顶部添加日期选择器
- 使用 `<div id="sleep-date-picker">` 包含：
  - 日期显示按钮（可点击展开日历）
  - 日历面板（默认隐藏）
  - "今天"快捷按钮

**日期选择器样式**
- 复用现有卡片样式 (`bg-card`)
- 圆角、间距与页面其他元素保持一致
- 紫色主题色呼应睡眠功能

**JavaScript 函数**
- `openSleepAnalysisModal(dateStr?)` - 带可选日期参数，默认为今天
- `renderSleepAnalysisByDate(dateStr)` - 根据指定日期渲染睡眠数据
- `toggleDatePicker()` - 展开/收起日历
- `selectDatePickerDate(dateStr)` - 选中日期并渲染数据
- `initSleepCalendar(year, month)` - 渲染月份日历
- `setSleepCalendarToday()` - 快速回到今天

### 数据过滤逻辑

在 `openSleepAnalysisModal` 中：
- 获取所有睡眠记录
- 根据选中的 `dateStr`（格式：YYYY-MM-DD）过滤
- 当日日期范围：`dateStr` 00:00:00 ~ dateStr 23:59:59

## 文件修改

- `templates/index.html`:
  - `#sleep-analysis-body` 顶部添加日期选择器 HTML（约30行）
  - 添加日期选择器 CSS 样式（约50行）
  - 修改 `openSleepAnalysisModal()` 函数接收日期参数
  - 新增日期选择相关 JS 函数（约80行）

## 验收标准

1. 打开睡眠分析弹窗默认显示今天
2. 点击日期按钮日历展开/收起正常
3. 切换月份日历正确显示
4. 点击不同日期显示对应日睡眠数据
5. "今天"按钮可快速回到当日
6. 无数据时显示"暂无睡眠记录"提示