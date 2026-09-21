# 睡眠分析日期筛选功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在睡眠分析弹窗中添加日期选择器，默认显示今天，点击展开日历切换不同日期查看睡眠数据

**Architecture:** 前端修改 `templates/index.html`，在睡眠分析弹窗中添加日期选择器组件，复用现有Modal样式，JavaScript处理日期过滤逻辑

**Tech Stack:** 原生HTML/CSS/JS，无新增依赖

---

## 文件修改

- Modify: `templates/index.html`
  - 在 `#sleep-analysis-body` 顶部添加日期选择器 HTML（约30行）
  - 添加日期选择器 CSS 样式（约50行）
  - 修改 `openSleepAnalysisModal()` 函数接收可选日期参数
  - 新增日期选择相关 JS 函数（约100行）

---

## Task 1: 添加日期选择器 HTML 结构

**Files:**
- Modify: `templates/index.html:1636-1646` (sleep-analysis-modal区域)

- [ ] **Step 1: 在 sleep-analysis-modal 的 modal-body 内添加日期选择器**

找到 `#sleep-analysis-body` (line 1642)，在其内部开头添加：

```html
<div id="sleep-date-picker" style="margin-bottom:16px;">
    <div class="date-picker-trigger" onclick="toggleSleepDatePicker()" style="display:flex;align-items:center;gap:8px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;cursor:pointer;">
        <span style="font-size:18px;">📅</span>
        <span id="sleep-current-date-text" style="flex:1;color:var(--text-primary);font-size:14px;font-weight:500;">加载中...</span>
        <span class="date-picker-arrow" style="color:var(--text-muted);transition:transform 0.2s;">▼</span>
    </div>
    <div id="sleep-date-calendar" class="sleep-calendar" style="display:none;margin-top:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <button onclick="sleepCalPrevMonth()" style="background:none;border:none;color:var(--text-primary);font-size:18px;cursor:pointer;padding:4px;">◀</button>
            <span id="sleep-cal-title" style="font-weight:600;color:var(--text-primary);">2026年5月</span>
            <button onclick="sleepCalNextMonth()" style="background:none;border:none;color:var(--text-primary);font-size:18px;cursor:pointer;padding:4px;">▶</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:8px;">
            <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
        </div>
        <div id="sleep-cal-days" style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;"></div>
        <button onclick="goToSleepToday()" style="width:100%;margin-top:12px;padding:8px;background:var(--accent-sleep,#7c3aed);color:white;border:none;border-radius:6px;font-size:13px;cursor:pointer;">今天</button>
    </div>
</div>
```

---

## Task 2: 添加日期选择器 CSS 样式

**Files:**
- Modify: `templates/index.html` 在 `<style>` 标签内添加

- [ ] **Step 1: 在 index.html 的 style 区域添加日期选择器相关样式**

在文件末尾 `</style>` 之前（约 line 1890 处），添加：

```css
/* Sleep Date Picker */
.sleep-calendar .cal-day {
    padding: 8px 4px;
    text-align: center;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-secondary);
    transition: all 0.15s;
}
.sleep-calendar .cal-day:hover {
    background: var(--bg-hover);
}
.sleep-calendar .cal-day.other-month {
    color: var(--text-muted);
    opacity: 0.5;
}
.sleep-calendar .cal-day.selected {
    background: var(--accent-sleep, #7c3aed);
    color: white;
    font-weight: 600;
}
.sleep-calendar .cal-day.today {
    border: 2px solid var(--accent-sleep, #7c3aed);
}
.sleep-calendar .cal-day.has-data {
    position: relative;
}
.sleep-calendar .cal-day.has-data::after {
    content: '';
    position: absolute;
    bottom: 2px;
    left: 50%;
    transform: translateX(-50%);
    width: 4px;
    height: 4px;
    background: var(--accent-sleep, #7c3aed);
    border-radius: 50%;
}
```

---

## Task 3: 添加 JavaScript 日期选择器逻辑

**Files:**
- Modify: `templates/index.html` 的 `<script>` 部分

- [ ] **Step 1: 添加全局变量和辅助函数**

在 `openSleepAnalysisModal` 函数之前添加：

```javascript
// Sleep Analysis Date Picker State
let sleepCalCurrentDate = new Date();
let sleepCalSelectedDate = null;
let sleepCalYear = 0;
let sleepCalMonth = 0;

function formatSleepDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatSleepDateDisplay(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const todayStr = formatSleepDate(now);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatSleepDate(yesterday);

    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const weekDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];

    if (dateStr === todayStr) {
        return `${month}月${day}日 (${weekDay}) - 今天`;
    } else if (dateStr === yesterdayStr) {
        return `${month}月${day}日 (${weekDay}) - 昨天`;
    } else {
        return `${year}年${month}月${day}日 (${weekDay})`;
    }
}

function toggleSleepDatePicker() {
    const calendar = document.getElementById('sleep-date-calendar');
    const arrow = document.querySelector('.date-picker-arrow');
    if (calendar.style.display === 'none') {
        calendar.style.display = 'block';
        arrow.style.transform = 'rotate(180deg)';
        initSleepCalendar(sleepCalYear, sleepCalMonth);
    } else {
        calendar.style.display = 'none';
        arrow.style.transform = 'rotate(0deg)';
    }
}

function initSleepCalendar(year, month) {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    sleepCalYear = year;
    sleepCalMonth = month;

    document.getElementById('sleep-cal-title').textContent = `${year}年${month + 1}月`;

    const daysContainer = document.getElementById('sleep-cal-days');
    daysContainer.innerHTML = '';

    // Previous month days
    const prevMonth = new Date(year, month, 0);
    const prevMonthDays = prevMonth.getDate();
    for (let i = startDay - 1; i >= 0; i--) {
        const day = prevMonthDays - i;
        const date = new Date(year, month - 1, day);
        const dateStr = formatSleepDate(date);
        daysContainer.innerHTML += `<div class="cal-day other-month" data-date="${dateStr}" onclick="selectSleepDate('${dateStr}')">${day}</div>`;
    }

    // Current month days
    const now = new Date();
    const todayStr = formatSleepDate(now);
    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const dateStr = formatSleepDate(date);
        let classes = 'cal-day';
        if (dateStr === todayStr) classes += ' today';
        if (dateStr === sleepCalSelectedDate) classes += ' selected';
        daysContainer.innerHTML += `<div class="${classes}" data-date="${dateStr}" onclick="selectSleepDate('${dateStr}')">${day}</div>`;
    }

    // Next month days
    const totalCells = startDay + daysInMonth;
    const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= remainingCells; i++) {
        const date = new Date(year, month + 1, i);
        const dateStr = formatSleepDate(date);
        daysContainer.innerHTML += `<div class="cal-day other-month" data-date="${dateStr}" onclick="selectSleepDate('${dateStr}')">${i}</div>`;
    }
}

function sleepCalPrevMonth() {
    if (sleepCalMonth === 0) {
        sleepCalYear--;
        sleepCalMonth = 11;
    } else {
        sleepCalMonth--;
    }
    initSleepCalendar(sleepCalYear, sleepCalMonth);
}

function sleepCalNextMonth() {
    if (sleepCalMonth === 11) {
        sleepCalYear++;
        sleepCalMonth = 0;
    } else {
        sleepCalMonth++;
    }
    initSleepCalendar(sleepCalYear, sleepCalMonth);
}

function selectSleepDate(dateStr) {
    sleepCalSelectedDate = dateStr;
    document.getElementById('sleep-current-date-text').textContent = formatSleepDateDisplay(dateStr);
    toggleSleepDatePicker();

    // Re-render sleep analysis for selected date
    const allRecords = window._sleepAnalysisRecords || [];
    renderSleepAnalysisByDate(dateStr, allRecords);
}

function goToSleepToday() {
    const now = new Date();
    sleepCalYear = now.getFullYear();
    sleepCalMonth = now.getMonth();
    sleepCalSelectedDate = formatSleepDate(now);
    document.getElementById('sleep-current-date-text').textContent = formatSleepDateDisplay(sleepCalSelectedDate);
    initSleepCalendar(sleepCalYear, sleepCalMonth);

    const allRecords = window._sleepAnalysisRecords || [];
    renderSleepAnalysisByDate(sleepCalSelectedDate, allRecords);
}
```

- [ ] **Step 2: 修改 openSleepAnalysisModal 函数**

找到 `async function openSleepAnalysisModal()` (约 line 1942)，在函数开头添加：

```javascript
// Initialize date picker state
const now = new Date();
sleepCalYear = now.getFullYear();
sleepCalMonth = now.getMonth();
sleepCalSelectedDate = formatSleepDate(now);
document.getElementById('sleep-current-date-text').textContent = formatSleepDateDisplay(sleepCalSelectedDate);
```

找到函数内获取 records 后添加存储：

```javascript
const res = await fetch('/api/records');
const allRecords = await res.json();
window._sleepAnalysisRecords = allRecords; // Store for date switching
```

将后续的 `todaySleepRecords` 过滤逻辑改为使用 `sleepCalSelectedDate`：

```javascript
// 替换原来的 todayStart 过滤逻辑
const selectedDate = sleepCalSelectedDate;
const dateStart = new Date(selectedDate + 'T00:00:00');
const dateEnd = new Date(selectedDate + 'T23:59:59');

const targetSleepRecords = allRecords.filter(r => {
    const t = new Date(r.time);
    return r.type === 'sleep' && t >= dateStart && t <= dateEnd;
});
```

同时需要在函数开头初始化日期选择器：

```javascript
// Initialize date picker
const now = new Date();
sleepCalYear = now.getFullYear();
sleepCalMonth = now.getMonth();
sleepCalSelectedDate = formatSleepDate(now);
```

- [ ] **Step 3: 添加 renderSleepAnalysisByDate 函数**

在 `openSleepAnalysisModal` 函数之后添加：

```javascript
async function renderSleepAnalysisByDate(dateStr, allRecords) {
    const body = document.getElementById('sleep-analysis-body');

    // 获取该日期的睡眠记录（复用上面的日期过滤逻辑）
    const dateStart = new Date(dateStr + 'T00:00:00');
    const dateEnd = new Date(dateStr + 'T23:59:59');

    const targetSleepRecords = allRecords.filter(r => {
        const t = new Date(r.time);
        return r.type === 'sleep' && t >= dateStart && t <= dateEnd;
    });

    if (targetSleepRecords.length === 0) {
        body.innerHTML = `
            <div id="sleep-date-picker-html" style="margin-bottom:16px;">
                <div class="date-picker-trigger" onclick="toggleSleepDatePicker()" style="display:flex;align-items:center;gap:8px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;cursor:pointer;">
                    <span style="font-size:18px;">📅</span>
                    <span id="sleep-current-date-text" style="flex:1;color:var(--text-primary);font-size:14px;font-weight:500;">${formatSleepDateDisplay(dateStr)}</span>
                    <span class="date-picker-arrow" style="color:var(--text-muted);transition:transform 0.2s;">▼</span>
                </div>
                <div id="sleep-date-calendar" class="sleep-calendar" style="display:none;margin-top:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:16px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                        <button onclick="sleepCalPrevMonth()" style="background:none;border:none;color:var(--text-primary);font-size:18px;cursor:pointer;padding:4px;">◀</button>
                        <span id="sleep-cal-title" style="font-weight:600;color:var(--text-primary);">${sleepCalYear}年${sleepCalMonth + 1}月</span>
                        <button onclick="sleepCalNextMonth()" style="background:none;border:none;color:var(--text-primary);font-size:18px;cursor:pointer;padding:4px;">▶</button>
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:8px;">
                        <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
                    </div>
                    <div id="sleep-cal-days" style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;"></div>
                    <button onclick="goToSleepToday()" style="width:100%;margin-top:12px;padding:8px;background:var(--accent-sleep,#7c3aed);color:white;border:none;border-radius:6px;font-size:13px;cursor:pointer;">今天</button>
                </div>
            </div>
            <div style="text-align:center;padding:40px 20px;color:var(--text-muted)">
                <div style="font-size:48px;margin-bottom:16px">🛏️</div>
                <div style="font-size:16px;font-weight:500">${formatSleepDateDisplay(dateStr).split(' - ')[0]} 暂无睡眠记录</div>
                <div style="font-size:13px;margin-top:8px">记录宝宝睡着和醒来时间，即可查看分析</div>
            </div>
        `;
        initSleepCalendar(sleepCalYear, sleepCalMonth);
        return;
    }

    // ... 其余复用现有的睡眠数据渲染逻辑
    // Build sleep pairs, sessions, totalSleepMins, quality, bar chart 等
    // (完整代码与 openSleepAnalysisModal 内的一致)
}
```

**注意：** 由于 `renderSleepAnalysisByDate` 需要复用现有的渲染逻辑，建议将 `openSleepAnalysisModal` 中的渲染部分提取为独立函数 `buildSleepAnalysisHTML(sessions, totalSleepMins, dateStr)`，然后两个函数都调用它。

---

## Task 4: 验证和测试

- [ ] **Step 1: 打开睡眠分析弹窗验证默认显示今天日期**
- [ ] **Step 2: 点击日期按钮展开日历**
- [ ] **Step 3: 切换月份验证日历正确**
- [ ] **Step 4: 点击不同日期验证数据切换**
- [ ] **Step 5: 点击"今天"按钮回到当日**

---

## 验收标准

1. 打开睡眠分析弹窗默认显示今天
2. 点击日期按钮日历展开/收起正常
3. 切换月份日历正确显示
4. 点击不同日期显示对应日睡眠数据
5. "今天"按钮可快速回到当日
6. 无数据时显示"暂无睡眠记录"提示