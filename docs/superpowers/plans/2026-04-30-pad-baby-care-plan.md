# PAD宝宝喂养版实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增PAD横屏老年版页面，翡翠雅致风格，共用后端接口和数据存储

**Architecture:** Flask后端新增`/pad`路由返回独立PAD页面，前端单HTML文件实现首页/记录列表单页切换，共用现有API接口

**Tech Stack:** Python Flask后端, Vanilla JS前端, CSS自定义样式

---

## 文件结构

```
/data/learning/baby/
├── baby.py                    # 新增 /pad 路由 + User-Agent检测
├── templates/
│   ├── index.html            # 现有手机版（不改）
│   └── pad.html               # 新增：PAD版页面
└── docs/superpowers/plans/    # 本计划
```

---

## 任务列表

### 任务1: 后端路由 — 添加PAD设备检测和`/pad`路由

**文件:**
- Modify: `baby.py` (在现有Flask app上新增路由)

- [ ] **Step 1: 查看当前 baby.py 结构，找到现有路由位置**

```bash
head -80 /data/learning/baby/baby.py
```

- [ ] **Step 2: 添加PAD检测函数和路由**

在 `baby.py` 末尾添加:

```python
def is_pad_device(user_agent):
    """检测是否为PAD设备"""
    if not user_agent:
        return False
    user_agent = user_agent.lower()
    # PAD关键词
    pad_keywords = ['ipad', 'tablet', 'pad', 'android.*tablet']
    for keyword in pad_keywords:
        import re
        if re.search(keyword, user_agent):
            return True
    # 屏幕宽度判断由前端辅助
    return False

@app.route('/pad')
def pad_page():
    """PAD版页面"""
    return render_template('pad.html')

@app.route('/')
def index():
    """根据设备类型返回对应页面"""
    user_agent = request.headers.get('User-Agent', '')
    if is_pad_device(user_agent):
        return render_template('pad.html')
    return render_template('index.html')
```

- [ ] **Step 3: 测试路由是否注册成功**

```bash
cd /data/learning/baby && python -c "from baby import app; print([rule.rule for rule in app.url_map.iter_rules()])"
```
Expected: 包含 `/` 和 `/pad`

- [ ] **Step 4: 提交**

```bash
git add baby.py
git commit -m "feat: add /pad route with device detection"
```

---

### 任务2: 创建PAD版HTML骨架

**文件:**
- Create: `templates/pad.html`

- [ ] **Step 1: 创建 pad.html 基础结构**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>宝宝喂养 - PAD版</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
    <style>
        /* CSS会统一在任务3添加 */
    </style>
</head>
<body>
    <!-- 首页视图 -->
    <div id="home-view">
        <div class="container">
            <div class="stats-panel">
                <h1 class="title">BABY CARE</h1>
                <p class="subtitle">今日概览</p>
                <div class="stats-grid">
                    <div class="stat-card stat-diaper">
                        <div class="stat-icon">💧</div>
                        <div class="stat-label">尿布</div>
                        <div class="stat-value" id="stat-diaper">0</div>
                    </div>
                    <div class="stat-card stat-feed">
                        <div class="stat-icon">🍼</div>
                        <div class="stat-label">喂养</div>
                        <div class="stat-value" id="stat-feed">0</div>
                    </div>
                    <div class="stat-card stat-vitamin">
                        <div class="stat-icon">☀️</div>
                        <div class="stat-label">维生素</div>
                        <div class="stat-value" id="stat-vitamin">0</div>
                    </div>
                    <div class="stat-card stat-bath">
                        <div class="stat-icon">🛁</div>
                        <div class="stat-label">洗澡</div>
                        <div class="stat-value" id="stat-bath">0</div>
                    </div>
                </div>
            </div>
            <div class="action-panel">
                <button class="action-btn btn-diaper" data-type="diaper">💧 尿布</button>
                <button class="action-btn btn-feed" data-type="feed">🍼 喂养</button>
                <button class="action-btn btn-vitamin" data-type="vitamin">☀️ 维生素</button>
                <button class="action-btn btn-bath" data-type="bath">🛁 洗澡</button>
                <button class="action-btn btn-records" id="btn-records">📋 记录</button>
            </div>
        </div>
    </div>

    <!-- 记录列表视图 -->
    <div id="records-view" style="display: none;">
        <div class="container">
            <div class="records-header">
                <button class="back-btn" id="btn-back">← 返回</button>
                <h2 class="records-title">📋 记录列表</h2>
            </div>
            <div class="records-list" id="records-list">
                <!-- 记录动态生成 -->
            </div>
        </div>
    </div>

    <!-- 表单弹窗 -->
    <div id="form-modal" class="modal" style="display: none;">
        <div class="modal-content">
            <h3 class="modal-title" id="modal-title">添加记录</h3>
            <div id="form-content">
                <!-- 表单动态生成 -->
            </div>
            <div class="modal-actions">
                <button class="btn-cancel" id="btn-cancel">取消</button>
                <button class="btn-confirm" id="btn-confirm">确认</button>
            </div>
        </div>
    </div>

    <script>
        // JS在任务4添加
    </script>
</body>
</html>
```

- [ ] **Step 2: 提交**

```bash
git add templates/pad.html
git commit -m "feat: create PAD page HTML skeleton"
```

---

### 任务3: 添加翡翠雅致CSS样式

**文件:**
- Modify: `templates/pad.html` (在`<style>`标签内添加完整CSS)

- [ ] **Step 1: 添加CSS变量和基础样式**

```css
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

:root {
    --bg-gradient-start: #1a3a2a;
    --bg-gradient-end: #2d5a3d;
    --card-bg: #F8F5F0;
    --text-primary: #2d5a3d;
    --text-secondary: #888;
    --diaper-color: #2d5a3d;
    --feed-color: #1565C0;
    --vitamin-color: #F57F17;
    --bath-color: #7B1FA2;
}

body {
    font-family: 'Outfit', sans-serif;
    min-height: 100vh;
    background: linear-gradient(135deg, var(--bg-gradient-start) 0%, var(--bg-gradient-end) 100%);
    padding: 20px;
}

.container {
    max-width: 1000px;
    margin: 0 auto;
    display: flex;
    gap: 30px;
    min-height: calc(100vh - 40px);
}
```

- [ ] **Step 2: 添加首页双栏布局样式**

```css
.stats-panel {
    flex: 1;
    background: var(--card-bg);
    border-radius: 24px;
    padding: 35px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
}

.action-panel {
    flex: 0.8;
    display: flex;
    flex-direction: column;
    gap: 20px;
}

.title {
    font-size: 22px;
    color: var(--text-primary);
    font-weight: 300;
    letter-spacing: 4px;
    margin-bottom: 8px;
}

.subtitle {
    font-size: 16px;
    color: var(--text-secondary);
    margin-bottom: 30px;
}

.stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
}

.stat-card {
    padding: 30px 20px;
    border-radius: 20px;
    text-align: center;
}

.stat-icon {
    font-size: 40px;
    margin-bottom: 8px;
}

.stat-label {
    font-size: 18px;
    margin-bottom: 8px;
}

.stat-value {
    font-size: 36px;
    font-weight: 600;
}

.stat-diaper { background: linear-gradient(135deg, #e8f5e9, #c8e6c9); color: #2d5a3d; }
.stat-feed { background: linear-gradient(135deg, #e3f2fd, #bbdefb); color: #1565C0; }
.stat-vitamin { background: linear-gradient(135deg, #fff8e1, #ffecb3); color: #F57F17; }
.stat-bath { background: linear-gradient(135deg, #f3e5f5, #e1bee7); color: #7B1FA2; }
```

- [ ] **Step 3: 添加按钮样式**

```css
.action-btn {
    flex: 1;
    padding: 35px;
    font-size: 28px;
    border-radius: 20px;
    border: none;
    color: white;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 15px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.2);
    transition: transform 0.2s, box-shadow 0.2s;
}

.action-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 25px rgba(0,0,0,0.3);
}

.action-btn:active {
    transform: translateY(0);
}

.btn-diaper { background: linear-gradient(135deg, #2d5a3d, #4a7c59); }
.btn-feed { background: linear-gradient(135deg, #1565C0, #1976D2); }
.btn-vitamin { background: linear-gradient(135deg, #F57F17, #FF8F00); }
.btn-bath { background: linear-gradient(135deg, #7B1FA2, #9C27B0); }
.btn-records { background: linear-gradient(135deg, #666, #888); }
```

- [ ] **Step 4: 添加记录列表和弹窗样式**

```css
.records-header {
    display: flex;
    align-items: center;
    gap: 20px;
    margin-bottom: 25px;
}

.back-btn {
    padding: 12px 24px;
    background: var(--card-bg);
    color: var(--text-primary);
    border: none;
    border-radius: 12px;
    font-size: 18px;
    cursor: pointer;
}

.records-title {
    font-size: 24px;
    color: var(--card-bg);
    font-weight: 400;
}

.records-list {
    background: var(--card-bg);
    border-radius: 24px;
    padding: 25px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
}

.record-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 18px 0;
    border-bottom: 1px solid #eee;
}

.record-item:last-child {
    border-bottom: none;
}

.record-info {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 20px;
}

.record-icon {
    font-size: 28px;
}

.record-time {
    font-size: 16px;
    color: #666;
}

.modal {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.modal-content {
    background: var(--card-bg);
    border-radius: 24px;
    padding: 35px;
    min-width: 400px;
    max-width: 500px;
}

.modal-title {
    font-size: 24px;
    color: var(--text-primary);
    margin-bottom: 25px;
    text-align: center;
}

.modal-actions {
    display: flex;
    gap: 15px;
    margin-top: 25px;
}

.btn-cancel, .btn-confirm {
    flex: 1;
    padding: 18px;
    font-size: 20px;
    border-radius: 14px;
    border: none;
    cursor: pointer;
}

.btn-cancel {
    background: #e0e0e0;
    color: #666;
}

.btn-confirm {
    background: var(--text-primary);
    color: white;
}
```

- [ ] **Step 5: 添加表单控件样式**

```css
.form-group {
    margin-bottom: 20px;
}

.form-label {
    display: block;
    font-size: 16px;
    color: var(--text-secondary);
    margin-bottom: 10px;
}

.form-options {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
}

.form-option {
    padding: 15px 25px;
    border-radius: 12px;
    border: 2px solid #ddd;
    background: white;
    font-size: 18px;
    cursor: pointer;
}

.form-option.selected {
    border-color: var(--text-primary);
    background: #e8f5e9;
}

.form-input {
    width: 100%;
    padding: 18px;
    font-size: 24px;
    border: 2px solid #ddd;
    border-radius: 12px;
    text-align: center;
}

.form-input:focus {
    outline: none;
    border-color: var(--text-primary);
}
```

- [ ] **Step 6: 提交**

```bash
git add templates/pad.html
git commit -m "feat: add jade-themed CSS styles for PAD page"
```

---

### 任务4: 添加JavaScript交互逻辑

**文件:**
- Modify: `templates/pad.html` (在`<script>`标签内添加JS)

- [ ] **Step 1: 添加API和状态管理基础代码**

```javascript
const API_BASE = '/api';

// 当前状态
let currentType = null;
let selectedOption = null;
let editingRecordId = null;

// DOM元素
const homeView = document.getElementById('home-view');
const recordsView = document.getElementById('records-view');
const formModal = document.getElementById('form-modal');
const recordsList = document.getElementById('records-list');
```

- [ ] **Step 2: 添加API请求函数**

```javascript
async function fetchRecords() {
    const res = await fetch(`${API_BASE}/records`);
    return await res.json();
}

async function createRecord(data) {
    const res = await fetch(`${API_BASE}/records`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(data)
    });
    return await res.json();
}

async function deleteRecord(id) {
    await fetch(`${API_BASE}/records/${id}`, {method: 'DELETE'});
}

async function updateRecord(id, data) {
    const res = await fetch(`${API_BASE}/records/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(data)
    });
    return await res.json();
}
```

- [ ] **Step 3: 添加统计刷新函数**

```javascript
async function refreshStats() {
    const records = await fetchRecords();
    const today = new Date().toDateString();

    const todayRecords = records.filter(r => {
        const recordDate = new Date(r.time).toDateString();
        return recordDate === today;
    });

    const counts = {
        diaper: todayRecords.filter(r => r.type === 'diaper').length,
        feed: todayRecords.filter(r => r.type === 'feed').length,
        vitamin: todayRecords.filter(r => r.type === 'vitamin').length,
        bath: todayRecords.filter(r => r.type === 'bath').length
    };

    document.getElementById('stat-diaper').textContent = counts.diaper;
    document.getElementById('stat-feed').textContent = counts.feed;
    document.getElementById('stat-vitamin').textContent = counts.vitamin;
    document.getElementById('stat-bath').textContent = counts.bath;
}
```

- [ ] **Step 4: 添加视图切换函数**

```javascript
function showHome() {
    homeView.style.display = 'block';
    recordsView.style.display = 'none';
    formModal.style.display = 'none';
    refreshStats();
}

function showRecords() {
    homeView.style.display = 'none';
    recordsView.style.display = 'block';
    formModal.style.display = 'none';
    renderRecordsList();
}

async function renderRecordsList() {
    const records = await fetchRecords();
    recordsList.innerHTML = records.map(r => {
        const time = new Date(r.time);
        const timeStr = time.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
        const dateStr = time.toDateString() === new Date().toDateString() ? '今天' : time.toLocaleDateString();
        return `
            <div class="record-item" data-id="${r.id}">
                <div class="record-info">
                    <span class="record-icon">${getIcon(r.type)}</span>
                    <span>${r.label || r.detail}</span>
                </div>
                <div>
                    <div class="record-time">${timeStr}</div>
                    <div class="record-time">${dateStr}</div>
                </div>
            </div>
        `;
    }).join('');
}

function getIcon(type) {
    const icons = {diaper: '💧', feed: '🍼', vitamin: '☀️', bath: '🛁'};
    return icons[type] || '📝';
}
```

- [ ] **Step 5: 添加表单弹窗函数**

```javascript
function showForm(type) {
    currentType = type;
    editingRecordId = null;
    selectedOption = null;

    const titles = {diaper: '💧 尿布记录', feed: '🍼 喂养记录', vitamin: '☀️ 维生素', bath: '🛁 洗澡记录'};
    document.getElementById('modal-title').textContent = titles[type];

    let formHtml = '';

    if (type === 'diaper') {
        formHtml = `
            <div class="form-group">
                <div class="form-options">
                    <button class="form-option" data-value="wet" onclick="selectOption(this)">💧 湿</button>
                    <button class="form-option" data-value="dirty" onclick="selectOption(this)">🟤 脏</button>
                    <button class="form-option" data-value="both" onclick="selectOption(this)">💫 两者</button>
                </div>
            </div>
        `;
    } else if (type === 'feed') {
        formHtml = `
            <div class="form-group">
                <label class="form-label">奶量 (ml)</label>
                <input type="number" class="form-input" id="feed-amount" placeholder="60" min="1" max="500">
            </div>
        `;
    } else if (type === 'vitamin') {
        formHtml = `
            <div class="form-group">
                <div class="form-options">
                    <button class="form-option" data-value="D3" onclick="selectOption(this)">☀️ 维生素D3</button>
                    <button class="form-option" data-value="AD" onclick="selectOption(this)">🌟 维生素AD</button>
                </div>
            </div>
        `;
    } else if (type === 'bath') {
        formHtml = `
            <div class="form-group">
                <p style="text-align: center; font-size: 18px; color: #666;">确认添加洗澡记录？</p>
            </div>
        `;
    }

    document.getElementById('form-content').innerHTML = formHtml;
    formModal.style.display = 'flex';
}

function selectOption(btn) {
    document.querySelectorAll('.form-option').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedOption = btn.dataset.value;
}

function closeModal() {
    formModal.style.display = 'none';
    currentType = null;
    selectedOption = null;
}
```

- [ ] **Step 6: 添加确认提交函数**

```javascript
document.getElementById('btn-confirm').addEventListener('click', async () => {
    let data = {type: currentType};

    if (currentType === 'diaper') {
        if (!selectedOption) {alert('请选择类型'); return;}
        data.feedType = selectedOption;
        data.label = selectedOption === 'wet' ? '💧 湿' : selectedOption === 'dirty' ? '🟤 脏' : '💫 两者';
        data.detail = data.label;
    } else if (currentType === 'feed') {
        const amount = document.getElementById('feed-amount').value;
        if (!amount) {alert('请输入奶量'); return;}
        data.feedType = 'bottle';
        data.amount = amount;
        data.label = '🍼 奶瓶';
        data.detail = `🍼 奶瓶 · ${amount}ml`;
    } else if (currentType === 'vitamin') {
        if (!selectedOption) {alert('请选择类型'); return;}
        data.feedType = selectedOption;
        data.label = selectedOption === 'D3' ? '☀️ 维生素D3' : '🌟 维生素AD';
        data.detail = data.label;
    } else if (currentType === 'bath') {
        data.label = '🛁 洗澡';
        data.detail = '🛁 洗澡';
    }

    await createRecord(data);
    closeModal();
    showHome();
});

document.getElementById('btn-cancel').addEventListener('click', closeModal);
```

- [ ] **Step 7: 添加按钮事件绑定和初始化**

```javascript
// 操作按钮事件
document.querySelectorAll('.action-btn[data-type]').forEach(btn => {
    btn.addEventListener('click', () => showForm(btn.dataset.type));
});

// 记录按钮
document.getElementById('btn-records').addEventListener('click', showRecords);

// 返回按钮
document.getElementById('btn-back').addEventListener('click', showHome);

// 初始化
showHome();

// 10秒自动刷新统计
setInterval(refreshStats, 10000);
```

- [ ] **Step 8: 提交**

```bash
git add templates/pad.html
git commit -m "feat: add JavaScript interactivity for PAD page"
```

---

### 任务5: 整体测试验证

**文件:**
- Test: 浏览器访问 `http://localhost:8888/pad`

- [ ] **Step 1: 启动服务器（如果未启动）**

```bash
cd /data/learning/baby && python baby.py &
```

- [ ] **Step 2: 用浏览器打开验证**

在PAD或浏览器开发者工具模拟PAD访问: `http://localhost:8888/pad`

验证清单:
- [ ] 翡翠绿背景显示正确
- [ ] 左侧统计卡片2×2网格显示
- [ ] 右侧5个按钮排列正确
- [ ] 点击"尿布"按钮弹出表单
- [ ] 选择选项后点击确认，记录保存
- [ ] 统计数字正确更新
- [ ] 点击"📋 记录"切换到记录列表
- [ ] 点击"← 返回"回到首页
- [ ] 记录列表正确显示所有记录

- [ ] **Step 3: 测试手机UA仍访问手机版**

用手机UA访问 `http://localhost:8888/` 应显示原手机版页面

- [ ] **Step 4: 提交最终版本**

```bash
git add -A
git commit -m "feat: complete PAD baby care version"
```

---

## 自检清单

- [ ] Spec覆盖：每个设计点都有对应任务
- [ ] 占位符检查：无"TODO"、无"TBD"、无模糊描述
- [ ] 类型一致性：函数名、变量名在任务间保持一致
- [ ] API复用：所有数据操作通过现有API完成
- [ ] 手机版兼容：原手机版完全不受影响
